export type CandidateProfile = {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  portfolio: string;
  resumeText: string;
  workAuthorization: string;
  sponsorship: string;
  salaryExpectation: string;
  noticePeriod: string;
  customNotes: string;
};

export type DetectedField = {
  id: string;
  tagName: string;
  type: string;
  name: string;
  label: string;
  placeholder: string;
  ariaLabel: string;
  required: boolean;
  options: string[];
};

export type JobContext = {
  url: string;
  title: string;
  pageText: string;
};

export type AutofillPayload = {
  profile: CandidateProfile;
  jobContext: JobContext;
  fields: DetectedField[];
};

export type FillInstruction = {
  id: string;
  value: string | boolean;
  confidence: number;
  reason?: string;
};

export type AutofillResult = {
  fills: FillInstruction[];
  warnings: string[];
};

export type ExtensionSettings = {
  apiBaseUrl: string;
  profile: CandidateProfile;
};

export const defaultSettings: ExtensionSettings = {
  apiBaseUrl: "http://localhost:8787",
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
    customNotes: ""
  }
};

export type ContentMessage =
  | { type: "COLLECT_FORM_CONTEXT" }
  | { type: "APPLY_FILLS"; fills: FillInstruction[] };

export type BackgroundMessage =
  | { type: "RUN_AUTOFILL"; tabId: number; settings: ExtensionSettings }
  | { type: "PING_API"; apiBaseUrl: string };
