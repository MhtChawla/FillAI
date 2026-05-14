import type {
  AutofillPayload,
  ContentMessage,
  DetectedField,
  FillInstruction,
  JobContext,
  ResumeAttachment
} from "./shared";

const FIELD_SELECTOR =
  "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled])";

const elementByFieldId = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();

chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
  if (message.type === "COLLECT_FORM_CONTEXT") {
    sendResponse({ payload: collectPayload() });
    return;
  }

  if (message.type === "COLLECT_JOB_CONTEXT") {
    sendResponse({ jobContext: collectJobContext() });
    return;
  }

  if (message.type === "APPLY_FILLS") {
    sendResponse(applyFills(message.fills));
    return;
  }

  if (message.type === "ATTACH_RESUME") {
    void attachResume(message.resume)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          attached: false,
          warning: error instanceof Error ? error.message : "Could not attach resume."
        });
      });
    return true;
  }
});

function collectPayload(): AutofillPayload {
  elementByFieldId.clear();

  const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(FIELD_SELECTOR))
    .filter(isVisibleField)
    .slice(0, 120)
    .map(toDetectedField);

  return {
    profile: {
      fullName: "",
      email: "",
      phone: "",
      location: "",
      linkedin: "",
      portfolio: "",
      resumeText: "",
      workAuthorization: "",
      sponsorship: "",
      salaryExpectation: "",
      noticePeriod: "",
      customNotes: "",
      customFields: [],
      resumes: [],
      currentResumeId: ""
    },
    jobContext: collectJobContext(),
    fields
  };
}

function collectJobContext(): JobContext {
  const main = document.querySelector("main")?.textContent ?? "";
  const bodyText = document.body?.innerText ?? "";
  const pageText = normalizeWhitespace(main || bodyText).slice(0, 18000);

  return {
    url: location.href,
    title: document.title,
    pageText
  };
}

function toDetectedField(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  index: number
): DetectedField {
  const id = `field-${index}-${stableFieldHint(element)}`;
  element.dataset.jobApplyAiFieldId = id;
  elementByFieldId.set(id, element);

  return {
    id,
    tagName: element.tagName.toLowerCase(),
    type: "type" in element ? element.type || "" : "",
    name: element.name || "",
    label: findLabel(element),
    placeholder: "placeholder" in element ? element.placeholder || "" : "",
    ariaLabel: element.getAttribute("aria-label") || "",
    required: element.required || element.getAttribute("aria-required") === "true",
    options: getOptions(element)
  };
}

function applyFills(fills: FillInstruction[]) {
  let applied = 0;
  let skipped = 0;

  for (const fill of fills) {
    const element = elementByFieldId.get(fill.id) ?? document.querySelector<HTMLElement>(`[data-job-apply-ai-field-id="${CSS.escape(fill.id)}"]`);

    if (!element || !isFillableElement(element)) {
      skipped += 1;
      continue;
    }

    if (applyValue(element, fill.value)) {
      applied += 1;
      markFilled(element);
    } else {
      skipped += 1;
    }
  }

  return { applied, skipped };
}

function applyValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string | boolean): boolean {
  if (element instanceof HTMLInputElement) {
    if (element.type === "file") return false;

    if (element.type === "checkbox") {
      setNativeChecked(element, Boolean(value));
      dispatchFillEvents(element);
      return true;
    }

    if (element.type === "radio") {
      const desired = String(value).toLowerCase();
      const group = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(element.name)}"]`);
      const match = Array.from(group).find((radio) => {
        const label = findLabel(radio).toLowerCase();
        return radio.value.toLowerCase() === desired || label === desired || label.includes(desired);
      });
      if (!match) return false;
      setNativeChecked(match, true);
      dispatchFillEvents(match);
      return true;
    }

    setNativeValue(element, String(value));
    dispatchFillEvents(element);
    return true;
  }

  if (element instanceof HTMLTextAreaElement) {
    setNativeValue(element, String(value));
    dispatchFillEvents(element);
    return true;
  }

  const selected = selectOption(element, String(value));
  if (selected) dispatchFillEvents(element);
  return selected;
}

async function attachResume(resume: ResumeAttachment): Promise<{ attached: boolean; warning?: string }> {
  const fileInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='file']:not([disabled])"));
  if (!fileInputs.length) {
    return { attached: false, warning: "No file upload field was detected for the resume." };
  }

  const target = findResumeFileInput(fileInputs) ?? fileInputs[0];
  if (!target) {
    return { attached: false, warning: "No file upload field was detected for the resume." };
  }

  const file = await resumeToFile(resume);
  const transfer = new DataTransfer();
  transfer.items.add(file);
  target.files = transfer.files;
  dispatchFillEvents(target);
  dispatchUploadEvents(target, transfer);
  markFilled(target);

  return { attached: true };
}

function findResumeFileInput(inputs: HTMLInputElement[]): HTMLInputElement | undefined {
  return inputs
    .map((input) => ({ input, score: scoreFileInput(input) }))
    .sort((a, b) => b.score - a.score)
    .find((candidate) => candidate.score > 0)?.input;
}

function scoreFileInput(input: HTMLInputElement): number {
  const text = normalizeForMatch(
    [
      input.name,
      input.id,
      input.accept,
      input.placeholder,
      input.getAttribute("aria-label") ?? "",
      input.getAttribute("title") ?? "",
      findLabel(input),
      findUploadContainerText(input)
    ].join(" ")
  );
  let score = isVisibleField(input) ? 2 : 0;

  if (/\b(resume|cv|curriculum|vitae)\b/.test(text)) score += 8;
  if (/\b(upload|attachment|attach|file)\b/.test(text)) score += 3;
  if (/\b(pdf|doc|docx|msword|wordprocessingml)\b/.test(text)) score += 2;
  if (input.accept && !/(pdf|doc|docx|msword|wordprocessingml|\*\/)/i.test(input.accept)) score -= 4;

  return score;
}

async function resumeToFile(resume: ResumeAttachment): Promise<File> {
  const response = await fetch(resume.dataUrl);
  const blob = await response.blob();
  return new File([blob], resume.name, { type: resume.mimeType || blob.type || "application/octet-stream" });
}

function selectOption(select: HTMLSelectElement, value: string): boolean {
  const normalized = normalizeForMatch(value);
  const option = Array.from(select.options).find((candidate) => {
    const label = normalizeForMatch(candidate.label || candidate.text);
    const optionValue = normalizeForMatch(candidate.value);
    return label === normalized || optionValue === normalized || label.includes(normalized);
  });

  if (!option) return false;
  option.selected = true;
  setNativeValue(select, option.value);
  return true;
}

function getOptions(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string[] {
  if (element instanceof HTMLSelectElement) {
    return Array.from(element.options)
      .map((option) => option.label || option.text || option.value)
      .filter(Boolean);
  }

  if (element instanceof HTMLInputElement && element.type === "radio" && element.name) {
    return Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(element.name)}"]`)).map((radio) =>
      normalizeWhitespace(findLabel(radio) || radio.value)
    );
  }

  return [];
}

function findLabel(element: HTMLElement): string {
  const labelElements =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? Array.from(element.labels ?? [])
      : [];
  const labels = labelElements.map((label) => label.textContent ?? "");
  const ariaLabelledBy = element.getAttribute("aria-labelledby");
  const ariaText = ariaLabelledBy
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const nearbyText = findNearbyText(element);

  return normalizeWhitespace([...labels, ariaText ?? "", nearbyText].find((text) => normalizeWhitespace(text)) ?? "");
}

function findNearbyText(element: HTMLElement): string {
  const parent = element.closest("label, div, li, p, section, fieldset");
  if (!parent) return "";

  const clone = parent.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("input, textarea, select, button, script, style").forEach((node) => node.remove());
  return clone.textContent ?? "";
}

function findUploadContainerText(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const label = element.id ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(element.id)}"]`)?.textContent : "";
  const container = element.closest("label, [role='button'], [role='group'], div, li, section, fieldset");

  return normalizeWhitespace([label ?? "", labelledBy ?? "", container?.textContent ?? ""].join(" "));
}

function isVisibleField(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const styles = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && styles.visibility !== "hidden" && styles.display !== "none";
}

function isFillableElement(element: Element): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (valueSetter) {
    valueSetter.call(element, value);
  } else {
    element.value = value;
  }
}

function setNativeChecked(element: HTMLInputElement, checked: boolean): void {
  const checkedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;

  if (checkedSetter) {
    checkedSetter.call(element, checked);
  } else {
    element.checked = checked;
  }
}

function dispatchFillEvents(element: HTMLElement): void {
  element.focus({ preventScroll: true });
  element.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
  element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  element.dispatchEvent(createInputEvent());
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
  element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  element.blur();
}

function dispatchUploadEvents(input: HTMLInputElement, dataTransfer: DataTransfer): void {
  const targets = new Set<HTMLElement>([
    input,
    input.closest<HTMLElement>("label, [role='button'], [role='group'], div, li, section, fieldset") ?? input
  ]);

  for (const target of targets) {
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }
}

function createInputEvent(): Event {
  if (typeof InputEvent === "function") {
    return new InputEvent("input", {
      bubbles: true,
      inputType: "insertReplacementText"
    });
  }

  return new Event("input", { bubbles: true });
}

function markFilled(element: HTMLElement): void {
  element.style.outline = "2px solid #23a455";
  element.style.outlineOffset = "2px";
  window.setTimeout(() => {
    element.style.outline = "";
    element.style.outlineOffset = "";
  }, 1800);
}

function stableFieldHint(element: HTMLElement): string {
  const hint = [element.id, element.getAttribute("name"), element.getAttribute("aria-label"), findLabel(element)]
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  return hint || "input";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}
