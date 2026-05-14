import {
  BriefcaseBusiness,
  CheckCircle2,
  CircleAlert,
  CircleX,
  FileText,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Wifi
} from "lucide-react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AtsMatchItem, AtsMatchResult, BackgroundMessage, CandidateProfile, CustomProfileField, ExtensionSettings, StoredResume } from "../shared";
import { defaultSettings } from "../shared";
import "./styles.css";

type RunState =
  | { status: "idle"; message: string }
  | { status: "loading"; message: string }
  | { status: "success"; message: string; warnings: string[] }
  | { status: "error"; message: string };

const storageKey = "jobApplyAiSettings";
const maxResumeBytes = 50 * 1024 * 1024;

type ActiveTab = "autofill" | "match";

function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings>(defaultSettings);
  const [activeTab, setActiveTab] = useState<ActiveTab>("match");
  const [state, setState] = useState<RunState>({ status: "idle", message: "Ready to fill the current page." });
  const [matchState, setMatchState] = useState<RunState>({ status: "idle", message: "Ready to score the current job." });
  const [matchResult, setMatchResult] = useState<AtsMatchResult | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [autoMatchStarted, setAutoMatchStarted] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get(storageKey).then((stored) => {
      const value = stored[storageKey] as Partial<ExtensionSettings> | undefined;
      if (!value) {
        setSettingsLoaded(true);
        return;
      }
      const customFields = Array.isArray(value.profile?.customFields) ? value.profile.customFields : [];
      const resumes = Array.isArray(value.profile?.resumes) ? value.profile.resumes.slice(0, 4) : [];
      const currentResumeId =
        typeof value.profile?.currentResumeId === "string" && resumes.some((resume) => resume.id === value.profile?.currentResumeId)
          ? value.profile.currentResumeId
          : (resumes[0]?.id ?? "");
      setSettings({
        ...defaultSettings,
        ...value,
        profile: {
          ...defaultSettings.profile,
          ...value.profile,
          customFields,
          resumes,
          currentResumeId
        }
      });
      setSettingsLoaded(true);
    });
  }, []);

  const profileCompleteness = useMemo(() => {
    const standardFields: Array<
      keyof Pick<
        CandidateProfile,
        | "fullName"
        | "email"
        | "phone"
        | "location"
        | "linkedin"
        | "portfolio"
        | "workAuthorization"
        | "sponsorship"
        | "salaryExpectation"
        | "noticePeriod"
      >
    > = [
      "fullName",
      "email",
      "phone",
      "location",
      "linkedin",
      "portfolio",
      "workAuthorization",
      "sponsorship",
      "salaryExpectation",
      "noticePeriod"
    ];
    const filledStandardFields = standardFields.filter((key) => settings.profile[key].trim().length > 0).length;
    const filledCustomFields = settings.profile.customFields.filter((field) => field.name.trim() && field.value.trim()).length;
    const filledResume = settings.profile.currentResumeId ? 1 : 0;
    return Math.round(
      ((filledStandardFields + filledCustomFields + filledResume) / (standardFields.length + settings.profile.customFields.length + 1)) * 100
    );
  }, [settings.profile]);

  const currentResume = useMemo(
    () => settings.profile.resumes.find((resume) => resume.id === settings.profile.currentResumeId) ?? settings.profile.resumes[0],
    [settings.profile.currentResumeId, settings.profile.resumes]
  );

  useEffect(() => {
    if (!settingsLoaded || autoMatchStarted || !currentResume) return;
    setAutoMatchStarted(true);
    void runAtsMatch();
  }, [autoMatchStarted, currentResume, settingsLoaded]);

  async function saveSettings(nextSettings = settings) {
    await chrome.storage.local.set({ [storageKey]: nextSettings });
    setState({ status: "success", message: "Settings saved.", warnings: [] });
  }

  async function testApi() {
    setState({ status: "loading", message: "Checking API connection..." });
    try {
      await sendBackgroundMessage({ type: "PING_API", apiBaseUrl: settings.apiBaseUrl });
      setState({ status: "success", message: "API is reachable.", warnings: [] });
    } catch (error) {
      setState({ status: "error", message: getErrorMessage(error) });
    }
  }

  async function runAutofill() {
    await saveSettings(settings);
    setState({ status: "loading", message: "Valuating & populating the application..." });

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab found.");

      const response = await sendBackgroundMessage<{
        ok: boolean;
        error?: string;
        data?: { applied: number; skipped: number; detectedFields: number; warnings: string[]; resumeAttached: boolean };
      }>({
        type: "RUN_AUTOFILL",
        tabId: tab.id,
        settings
      });

      if (!response.ok || !response.data) {
        throw new Error(response.error ?? "Autofill failed.");
      }

      setState({
        status: "success",
        message: [
          `Applied ${response.data.applied} fields. Detected ${response.data.detectedFields}; skipped ${response.data.skipped}.`,
          response.data.resumeAttached ? "Resume attached." : ""
        ]
          .filter(Boolean)
          .join(" "),
        warnings: response.data.warnings
      });
    } catch (error) {
      setState({ status: "error", message: getErrorMessage(error) });
    }
  }

  async function runAtsMatch() {
    await saveSettings(settings);
    setMatchState({ status: "loading", message: "Reading this job page and comparing it with your current resume..." });
    setMatchResult(null);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab found.");

      const response = await sendBackgroundMessage<{
        ok: boolean;
        error?: string;
        data?: AtsMatchResult;
      }>({
        type: "RUN_ATS_MATCH",
        tabId: tab.id,
        settings
      });

      if (!response.ok || !response.data) {
        throw new Error(response.error ?? "ATS match failed.");
      }

      setMatchResult(response.data);
      setMatchState({
        status: "success",
        message: `Match score ready for ${response.data.jobTitle || "this role"}.`,
        warnings: response.data.warnings
      });
    } catch (error) {
      setMatchState({ status: "error", message: getErrorMessage(error) });
    }
  }

  function updateProfile<K extends keyof CandidateProfile>(key: K, value: CandidateProfile[K]) {
    setSettings((current) => ({
      ...current,
      profile: {
        ...current.profile,
        [key]: value
      }
    }));
  }

  function addCustomField() {
    updateProfile("customFields", [...settings.profile.customFields, createCustomField()]);
  }

  function updateCustomField(id: string, patch: Partial<Pick<CustomProfileField, "name" | "value">>) {
    updateProfile(
      "customFields",
      settings.profile.customFields.map((field) => (field.id === id ? { ...field, ...patch } : field))
    );
  }

  function removeCustomField(id: string) {
    updateProfile(
      "customFields",
      settings.profile.customFields.filter((field) => field.id !== id)
    );
  }

  async function addResumes(files: FileList | null) {
    if (!files?.length) return;

    const openSlots = Math.max(0, 4 - settings.profile.resumes.length);
    if (!openSlots) {
      setState({ status: "error", message: "You can store up to 4 resumes." });
      return;
    }

    const selectedFiles = Array.from(files).slice(0, openSlots);
    const oversizedFile = selectedFiles.find((file) => file.size > maxResumeBytes);
    if (oversizedFile) {
      setState({ status: "error", message: `${oversizedFile.name} is over the 50 MB resume limit.` });
      return;
    }

    const nextResumes = await Promise.all(selectedFiles.map(toStoredResume));
    const resumes = [...settings.profile.resumes, ...nextResumes];
    updateProfile("resumes", resumes);
    if (!settings.profile.currentResumeId && resumes[0]) {
      updateProfile("currentResumeId", resumes[0].id);
    }
  }

  function setCurrentResume(id: string) {
    updateProfile("currentResumeId", id);
  }

  function removeResume(id: string) {
    const resumes = settings.profile.resumes.filter((resume) => resume.id !== id);
    setSettings((current) => ({
      ...current,
      profile: {
        ...current.profile,
        resumes,
        currentResumeId: current.profile.currentResumeId === id ? (resumes[0]?.id ?? "") : current.profile.currentResumeId
      }
    }));
  }

  return (
    <main>
      <header>
        <div>
          <h1>FillAI</h1>
          <p>{profileCompleteness}% profile ready</p>
        </div>
        <button className="icon-button" onClick={testApi} title="Test API connection" type="button">
          <Wifi size={18} />
        </button>
      </header>

      <section className="toolbar">
        <button className="primary" disabled={state.status === "loading"} onClick={runAutofill} type="button">
          {state.status === "loading" ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
          Autofill page
        </button>
        <button className="secondary" onClick={() => void saveSettings()} type="button">
          <Save size={17} />
          Save
        </button>
      </section>

      <nav className="tabs" aria-label="FillAI sections">
        <button className={activeTab === "match" ? "tab active" : "tab"} onClick={() => setActiveTab("match")} type="button">
          <BriefcaseBusiness size={16} />
          ATS Match
        </button>
        <button className={activeTab === "autofill" ? "tab active" : "tab"} onClick={() => setActiveTab("autofill")} type="button">
          <Sparkles size={16} />
          Autofill
        </button>
      </nav>

      {activeTab === "match" ? (
        <section className="match-tab">
          <div className="current-job-resume">
            <div>
              <span>Current resume</span>
              <strong>{currentResume?.name ?? "No resume selected"}</strong>
            </div>
            <FileText size={18} />
          </div>

          <button className="primary wide-action" disabled={matchState.status === "loading" || !currentResume} onClick={runAtsMatch} type="button">
            {matchState.status === "loading" ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            Score current job
          </button>

          <StatusView state={matchState} />
          {matchResult ? <AtsMatchView result={matchResult} /> : null}
        </section>
      ) : (
        <>
          <StatusView state={state} />

          <section className="settings">
            <label>
              API URL
              <input value={settings.apiBaseUrl} onChange={(event) => setSettings({ ...settings, apiBaseUrl: event.target.value })} />
            </label>
          </section>

          <section className="profile-grid">
            <Field label="Full name" value={settings.profile.fullName} onChange={(value) => updateProfile("fullName", value)} />
            <Field label="Email" value={settings.profile.email} onChange={(value) => updateProfile("email", value)} />
            <Field label="Phone" value={settings.profile.phone} onChange={(value) => updateProfile("phone", value)} />
            <Field label="Location" value={settings.profile.location} onChange={(value) => updateProfile("location", value)} />
            <Field label="LinkedIn" value={settings.profile.linkedin} onChange={(value) => updateProfile("linkedin", value)} />
            <Field label="Portfolio" value={settings.profile.portfolio} onChange={(value) => updateProfile("portfolio", value)} />
            <Field label="Work authorization" value={settings.profile.workAuthorization} onChange={(value) => updateProfile("workAuthorization", value)} />
            <Field label="Sponsorship" value={settings.profile.sponsorship} onChange={(value) => updateProfile("sponsorship", value)} />
            <Field label="Salary expectation" value={settings.profile.salaryExpectation} onChange={(value) => updateProfile("salaryExpectation", value)} />
            <Field label="Notice period" value={settings.profile.noticePeriod} onChange={(value) => updateProfile("noticePeriod", value)} />
          </section>

          <section className="resume-manager">
        <div className="section-heading">
          <div>
            <h2>Resume files</h2>
            <p>{settings.profile.resumes.length}/4 saved. The current resume is attached to job sites.</p>
          </div>
          <label className={`icon-button upload-button ${settings.profile.resumes.length >= 4 ? "disabled" : ""}`} title="Upload resume files">
            <Upload size={18} />
            <input
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              disabled={settings.profile.resumes.length >= 4}
              multiple
              onChange={(event) => {
                void addResumes(event.target.files);
                event.currentTarget.value = "";
              }}
              type="file"
            />
          </label>
        </div>

        {settings.profile.resumes.length > 0 ? (
          <div className="resume-list">
            {settings.profile.resumes.map((resume) => (
              <div className="resume-row" key={resume.id}>
                <label className="current-resume">
                  <input
                    checked={settings.profile.currentResumeId === resume.id}
                    name="currentResume"
                    onChange={() => setCurrentResume(resume.id)}
                    type="radio"
                  />
                  <FileText size={16} />
                  <span>{resume.name}</span>
                </label>
                <button className="icon-button danger" onClick={() => removeResume(resume.id)} title="Remove resume" type="button">
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
          </section>

          <section className="custom-fields">
        <div className="section-heading">
          <div>
            <h2>Custom fields</h2>
            <p>Name/value pairs for site-specific questions.</p>
          </div>
          <button className="icon-button" onClick={addCustomField} title="Add custom field" type="button">
            <Plus size={18} />
          </button>
        </div>

        {settings.profile.customFields.length > 0 ? (
          <div className="custom-field-list">
            {settings.profile.customFields.map((field) => (
              <div className="custom-field-row" key={field.id}>
                <Field label="Name" value={field.name} onChange={(value) => updateCustomField(field.id, { name: value })} />
                <Field label="Value" value={field.value} onChange={(value) => updateCustomField(field.id, { value })} />
                <button className="icon-button danger" onClick={() => removeCustomField(field.id)} title="Remove custom field" type="button">
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
          </section>
        </>
      )}
    </main>
  );
}

function createCustomField(): CustomProfileField {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: "",
    value: ""
  };
}

async function toStoredResume(file: File): Promise<StoredResume> {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    dataUrl: await readFileAsDataUrl(file),
    uploadedAt: new Date().toISOString()
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read resume file.")));
    reader.readAsDataURL(file);
  });
}

function AtsMatchView({ result }: { result: AtsMatchResult }) {
  return (
    <section className="match-results">
      <div className="score-card">
        <div>
          <span>Resume match score</span>
          <strong>{result.overallScore}%</strong>
        </div>
        <ScoreBar label="Skills" score={result.skillsScore} tone="blue" />
        <ScoreBar label="Requirements" score={result.requirementsScore} tone="green" />
        <ScoreBar label="Responsibilities" score={result.responsibilitiesScore} tone="pink" />
      </div>

      <div className="job-summary">
        <BriefcaseBusiness size={18} />
        <div>
          <strong>{result.jobTitle || "Detected job"}</strong>
          <span>{result.company || "Company not detected"}</span>
        </div>
      </div>

      <SkillSection
        title={`Skills matched (${result.matchedSkills.length}/${result.matchedSkills.length + result.missingSkills.length})`}
        skills={result.matchedSkills}
        missing={false}
      />
      <SkillSection title="Skills to improve" skills={result.missingSkills} missing />
      <MatchList title="Job requirements" items={result.requirements} />
      <MatchList title="Job responsibilities" items={result.responsibilities} />

      {result.recommendations.length > 0 ? (
        <section className="match-panel">
          <h2>Resume suggestions</h2>
          <ul className="recommendations">
            {result.recommendations.slice(0, 5).map((recommendation) => (
              <li key={recommendation}>{recommendation}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function ScoreBar({ label, score, tone }: { label: string; score: number; tone: "blue" | "green" | "pink" }) {
  return (
    <div className="score-row">
      <div>
        <span>{label}</span>
        <strong>{score}%</strong>
      </div>
      <div className="score-track">
        <span className={`score-fill ${tone}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
    </div>
  );
}

function SkillSection({ title, skills, missing }: { title: string; skills: string[]; missing: boolean }) {
  if (!skills.length) return null;

  return (
    <section className="match-panel">
      <h2>{title}</h2>
      <div className="skill-cloud">
        {skills.slice(0, 12).map((skill) => (
          <span className={missing ? "skill missing" : "skill matched"} key={skill}>
            {skill}
            {missing ? <CircleX size={14} /> : <CheckCircle2 size={14} />}
          </span>
        ))}
      </div>
    </section>
  );
}

function MatchList({ title, items }: { title: string; items: AtsMatchItem[] }) {
  if (!items.length) return null;

  return (
    <section className="match-panel">
      <h2>{title}</h2>
      <div className="match-list">
        {items.slice(0, 6).map((item) => (
          <article className="match-item" key={`${item.text}-${item.importance}`}>
            {item.matched ? <CheckCircle2 className="match-icon" size={17} /> : <CircleAlert className="gap-icon" size={17} />}
            <div>
              <p>{item.text}</p>
              <span className={`importance ${item.importance}`}>{item.importance}</span>
              <small>{item.evidence}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Field(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      {props.label}
      <input value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

function StatusView({ state }: { state: RunState }) {
  return (
    <section className={`status ${state.status}`}>
      <div className="status-line">
        {state.status === "success" ? <CheckCircle2 size={17} /> : null}
        <span>{state.message}</span>
      </div>
      {"warnings" in state && state.warnings.length > 0 ? (
        <ul>
          {state.warnings.slice(0, 5).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

async function sendBackgroundMessage<T = unknown>(message: BackgroundMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Popup />
  </StrictMode>
);
