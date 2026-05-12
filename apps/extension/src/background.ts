import type {
  AutofillPayload,
  AutofillResult,
  BackgroundMessage,
  CandidateProfile,
  ContentMessage,
  ExtensionSettings
} from "./shared";

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  void handleMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected extension error"
      });
    });

  return true;
});

async function handleMessage(message: BackgroundMessage) {
  if (message.type === "PING_API") {
    const response = await fetch(`${message.apiBaseUrl}/health`);
    if (!response.ok) throw new Error(`API health check failed: ${response.status}`);
    return { ok: true, data: await response.json() };
  }

  if (message.type === "RUN_AUTOFILL") {
    return runAutofill(message.tabId, message.settings);
  }

  return { ok: false, error: "Unknown message type" };
}

async function runAutofill(tabId: number, settings: ExtensionSettings) {
  const contextResponse = await sendToTab<{ payload: AutofillPayload }>(tabId, {
    type: "COLLECT_FORM_CONTEXT"
  });

  if (!contextResponse.payload.fields.length) {
    return {
      ok: false,
      error: "No fillable form fields were detected on this page."
    };
  }

  const apiResponse = await fetch(`${settings.apiBaseUrl}/api/autofill`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      ...contextResponse.payload,
      profile: profileForApi(settings.profile)
    })
  });

  if (!apiResponse.ok) {
    const text = await apiResponse.text();
    throw new Error(`API autofill failed: ${apiResponse.status} ${text}`);
  }

  const result = (await apiResponse.json()) as AutofillResult;
  const applyResponse = await sendToTab<{ applied: number; skipped: number }>(tabId, {
    type: "APPLY_FILLS",
    fills: result.fills
  });
  const resume = getCurrentResume(settings.profile);
  const attachmentWarnings = [...result.warnings];

  if (resume) {
    const attachResponse = await sendToTab<{ attached: boolean; warning?: string }>(tabId, {
      type: "ATTACH_RESUME",
      resume: {
        name: resume.name,
        mimeType: resume.mimeType,
        dataUrl: resume.dataUrl
      }
    });

    if (attachResponse.warning) {
      attachmentWarnings.push(attachResponse.warning);
    }
  }

  return {
    ok: true,
    data: {
      ...result,
      warnings: attachmentWarnings,
      applied: applyResponse.applied,
      skipped: applyResponse.skipped,
      detectedFields: contextResponse.payload.fields.length
    }
  };
}

function getCurrentResume(profile: CandidateProfile) {
  return profile.resumes.find((resume) => resume.id === profile.currentResumeId) ?? profile.resumes[0];
}

function profileForApi(profile: CandidateProfile): CandidateProfile {
  const currentResume = getCurrentResume(profile);
  return {
    ...profile,
    currentResumeId: currentResume?.id ?? "",
    resumes: profile.resumes.map((resume) => ({
      id: resume.id,
      name: resume.name,
      mimeType: resume.mimeType,
      uploadedAt: resume.uploadedAt,
      dataUrl: resume.id === currentResume?.id ? resume.dataUrl : ""
    }))
  };
}

function sendToTab<T>(tabId: number, message: ContentMessage): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}
