import cors from "@fastify/cors";
import "dotenv/config";
import Fastify from "fastify";
import OpenAI from "openai";
import type { ResponseInputMessageContentList } from "openai/resources/responses/responses";
import { z } from "zod";

const env = z
  .object({
    OPENAI_API_KEY: z.string().min(1),
    PORT: z.coerce.number().int().positive().default(8787),
    CORS_ORIGIN: z.string().default("*"),
    OPENAI_MODEL: z.string().default("gpt-5.4")
  })
  .safeParse(process.env);

if (!env.success) {
  console.error("Invalid API environment:", env.error.flatten().fieldErrors);
  process.exit(1);
}

const config = env.data;
const app = Fastify({ logger: true, bodyLimit: 55 * 1024 * 1024 });
const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const candidateProfileSchema = z.object({
  fullName: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  phoneCountryCode: z.string().default(""),
  location: z.string().default(""),
  addressLine1: z.string().default(""),
  pincode: z.string().default(""),
  country: z.string().default(""),
  state: z.string().default(""),
  linkedin: z.string().default(""),
  github: z.string().default(""),
  portfolio: z.string().default(""),
  collegeUniversity: z.string().default(""),
  experienceYears: z.string().default(""),
  totalExperienceYears: z.string().default(""),
  resumeText: z.string().default(""),
  workAuthorization: z.string().default(""),
  sponsorship: z.string().default(""),
  salaryExpectation: z.string().default(""),
  expectedSalary: z.string().default(""),
  currentOffer: z.string().default(""),
  offerInHand: z.string().default(""),
  nationality: z.string().default(""),
  noticePeriod: z.string().default(""),
  customNotes: z.string().default(""),
  customFields: z
    .array(
      z.object({
        id: z.string().default(""),
        name: z.string().default(""),
        value: z.string().default("")
      })
    )
    .default([]),
  resumes: z
    .array(
      z.object({
        id: z.string().default(""),
        name: z.string().default(""),
        mimeType: z.string().default(""),
        dataUrl: z.string().default(""),
        uploadedAt: z.string().default("")
      })
    )
    .max(4)
    .default([]),
  currentResumeId: z.string().default("")
});

const formFieldSchema = z.object({
  id: z.string(),
  tagName: z.string(),
  type: z.string().default(""),
  name: z.string().default(""),
  label: z.string().default(""),
  placeholder: z.string().default(""),
  ariaLabel: z.string().default(""),
  required: z.boolean().default(false),
  options: z.array(z.string()).default([])
});

const autofillRequestSchema = z.object({
  profile: candidateProfileSchema,
  jobContext: z.object({
    url: z.string().url().optional().or(z.literal("")),
    title: z.string().default(""),
    pageText: z.string().default("")
  }),
  fields: z.array(formFieldSchema).min(1).max(120)
});

const jobContextSchema = z.object({
  url: z.string().url().optional().or(z.literal("")),
  title: z.string().default(""),
  pageText: z.string().min(1).max(20000)
});

const atsMatchRequestSchema = z.object({
  profile: candidateProfileSchema,
  jobContext: jobContextSchema
});

type AutofillResponse = {
  fills: Array<{
    id: string;
    value: string | boolean;
    confidence: number;
    reason?: string;
  }>;
  warnings: string[];
};

type AtsMatchResponse = {
  overallScore: number;
  skillsScore: number;
  requirementsScore: number;
  responsibilitiesScore: number;
  jobTitle: string;
  company: string;
  matchedSkills: string[];
  missingSkills: string[];
  requirements: Array<{
    text: string;
    matched: boolean;
    importance: "critical" | "important" | "nice-to-have";
    evidence: string;
  }>;
  responsibilities: Array<{
    text: string;
    matched: boolean;
    importance: "critical" | "important" | "nice-to-have";
    evidence: string;
  }>;
  recommendations: string[];
  warnings: string[];
};

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin || config.CORS_ORIGIN === "*") {
      callback(null, true);
      return;
    }

    const allowed = config.CORS_ORIGIN.split(",").map((value) => value.trim());
    callback(null, allowed.includes(origin));
  }
});

app.get("/health", async () => ({
  ok: true,
  model: config.OPENAI_MODEL,
  provider: "openai"
}));

app.post("/api/autofill", async (request, reply) => {
  const parsed = autofillRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "Invalid autofill payload",
      details: parsed.error.flatten()
    });
  }

  const response = await openai.responses.create({
    model: config.OPENAI_MODEL,
    max_output_tokens: 3500,
    temperature: 0.2,
    instructions:
      "You are a careful job application autofill assistant. Use the candidate profile and current resume file as the source of truth. Do not invent credentials, degrees, employers, dates, salaries, immigration status, protected-class information, or legal claims. If a field needs information that is missing, omit the fill and add a warning.",
    input: [
      {
        role: "user",
        content: buildAutofillContent(parsed.data)
      }
    ],
    text: {
      format: autofillJsonSchema
    }
  });

  const result = parseOpenAIJson(response.output_text);
  return result;
});

app.post("/api/cover-letter", async (request, reply) => {
  const schema = z.object({
    profile: candidateProfileSchema,
    jobDescription: z.string().min(1).max(20000),
    tone: z.enum(["concise", "warm", "confident"]).default("confident")
  });

  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "Invalid cover letter payload",
      details: parsed.error.flatten()
    });
  }

  const message = await openai.responses.create({
    model: config.OPENAI_MODEL,
    max_output_tokens: 1600,
    temperature: 0.35,
    instructions:
      "Write truthful, specific job application materials. Do not invent experience. Keep the output directly usable.",
    input: [
      {
        role: "user",
        content: `Create a ${parsed.data.tone} cover letter from this candidate profile and job description.\n\nCandidate profile:\n${JSON.stringify(parsed.data.profile, null, 2)}\n\nJob description:\n${parsed.data.jobDescription}`
      }
    ]
  });

  return {
    coverLetter: message.output_text
  };
});

app.post("/api/ats-match", async (request, reply) => {
  const parsed = atsMatchRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "Invalid ATS match payload",
      details: parsed.error.flatten()
    });
  }

  const response = await openai.responses.create({
    model: config.OPENAI_MODEL,
    max_output_tokens: 2600,
    temperature: 0.2,
    instructions:
      "You are a truthful ATS resume-to-job matching assistant. Compare only the supplied current resume/profile against the job page text. Do not invent experience. Penalize critical missing requirements more than nice-to-have gaps.",
    input: [
      {
        role: "user",
        content: buildAtsMatchContent(parsed.data)
      }
    ],
    text: {
      format: atsMatchJsonSchema
    }
  });

  return parseAtsMatchJson(response.output_text);
});

app.listen({ port: config.PORT, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

function buildAutofillContent(input: z.infer<typeof autofillRequestSchema>): string | ResponseInputMessageContentList {
  const prompt = buildAutofillPrompt(input);
  const currentResume = getCurrentResume(input.profile);
  if (!currentResume?.dataUrl) {
    return prompt;
  }

  return [
    {
      type: "input_text",
      text: prompt
    },
    {
      type: "input_file",
      filename: currentResume.name || "resume",
      file_data: currentResume.dataUrl
    }
  ];
}

function buildAutofillPrompt(input: z.infer<typeof autofillRequestSchema>): string {
  const promptProfile = {
    ...input.profile,
    resumes: input.profile.resumes.map((resume) => ({
      id: resume.id,
      name: resume.name,
      mimeType: resume.mimeType,
      uploadedAt: resume.uploadedAt,
      isCurrent: resume.id === input.profile.currentResumeId
    }))
  };

  return `Fill this job application form.

Return strict JSON only:
{
  "fills": [
    {
      "id": "field id from input",
      "value": "string or boolean",
      "confidence": 0.0,
      "reason": "short optional reason"
    }
  ],
  "warnings": ["short warning"]
}

Rules:
- Use exact field ids from the input.
- For select/radio fields, choose one of the provided options exactly when possible.
- For checkbox fields, use boolean values.
- For missing or sensitive unknown answers, skip the field and add a warning.
- Treat customFields as user-provided profile facts. Match them by semantic meaning, even when the webpage label uses different wording than the custom field name.
- Use the attached current resume file to answer job-portal custom questions when the answer is supported by the resume or profile.
- For free-text custom questions, write in a human voice. Keep answers short, usually 2-3 lines or under 60 words. Add a compact example, context, or story only when it is grounded in the resume/profile and helps the answer feel specific.
- Do not claim the user has experience or authorization that is not in the profile.
- Keep long-answer responses under 120 words unless the field clearly asks for a cover-letter-like answer.

Candidate profile:
${JSON.stringify(promptProfile, null, 2)}

Job context:
${JSON.stringify(input.jobContext, null, 2)}

Fields:
${JSON.stringify(input.fields, null, 2)}`;
}

function buildAtsMatchContent(input: z.infer<typeof atsMatchRequestSchema>): string | ResponseInputMessageContentList {
  const prompt = buildAtsMatchPrompt(input);
  const currentResume = getCurrentResume(input.profile);
  if (!currentResume?.dataUrl) {
    return prompt;
  }

  return [
    {
      type: "input_text",
      text: prompt
    },
    {
      type: "input_file",
      filename: currentResume.name || "resume",
      file_data: currentResume.dataUrl
    }
  ];
}

function buildAtsMatchPrompt(input: z.infer<typeof atsMatchRequestSchema>): string {
  const currentResume = getCurrentResume(input.profile);
  const promptProfile = {
    ...input.profile,
    resumes: input.profile.resumes.map((resume) => ({
      id: resume.id,
      name: resume.name,
      mimeType: resume.mimeType,
      uploadedAt: resume.uploadedAt,
      isCurrent: resume.id === currentResume?.id
    }))
  };

  return `Score how well the current resume matches this job description.

Return strict JSON only:
{
  "overallScore": 0,
  "skillsScore": 0,
  "requirementsScore": 0,
  "responsibilitiesScore": 0,
  "jobTitle": "",
  "company": "",
  "matchedSkills": ["skill"],
  "missingSkills": ["skill"],
  "requirements": [
    {
      "text": "requirement from the job",
      "matched": true,
      "importance": "critical",
      "evidence": "short resume-backed evidence or gap"
    }
  ],
  "responsibilities": [
    {
      "text": "responsibility from the job",
      "matched": false,
      "importance": "important",
      "evidence": "short resume-backed evidence or gap"
    }
  ],
  "recommendations": ["specific resume improvement"],
  "warnings": ["short warning"]
}

Rules:
- Scores are integers from 0 to 100.
- Extract 4-10 important skills, then split them into matchedSkills and missingSkills.
- Extract 3-6 requirements and 3-6 responsibilities from the job page.
- Mark an item matched only when the resume/profile directly supports it or strongly implies it.
- Keep evidence and recommendations concise.
- If the page text is noisy, focus on the actual job posting content and add a warning.

Candidate profile:
${JSON.stringify(promptProfile, null, 2)}

Job page:
${JSON.stringify(input.jobContext, null, 2)}`;
}

function getCurrentResume(profile: z.infer<typeof candidateProfileSchema>) {
  return profile.resumes.find((resume) => resume.id === profile.currentResumeId) ?? profile.resumes[0];
}

const autofillJsonSchema = {
  type: "json_schema",
  name: "autofill_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      fills: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            value: {
              anyOf: [{ type: "string" }, { type: "boolean" }]
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1
            },
            reason: { type: "string" }
          },
          required: ["id", "value", "confidence", "reason"]
        }
      },
      warnings: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["fills", "warnings"]
  }
} as const;

const atsMatchItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    matched: { type: "boolean" },
    importance: { type: "string", enum: ["critical", "important", "nice-to-have"] },
    evidence: { type: "string" }
  },
  required: ["text", "matched", "importance", "evidence"]
} as const;

const atsMatchJsonSchema = {
  type: "json_schema",
  name: "ats_match_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      overallScore: { type: "integer", minimum: 0, maximum: 100 },
      skillsScore: { type: "integer", minimum: 0, maximum: 100 },
      requirementsScore: { type: "integer", minimum: 0, maximum: 100 },
      responsibilitiesScore: { type: "integer", minimum: 0, maximum: 100 },
      jobTitle: { type: "string" },
      company: { type: "string" },
      matchedSkills: {
        type: "array",
        items: { type: "string" }
      },
      missingSkills: {
        type: "array",
        items: { type: "string" }
      },
      requirements: {
        type: "array",
        items: atsMatchItemSchema
      },
      responsibilities: {
        type: "array",
        items: atsMatchItemSchema
      },
      recommendations: {
        type: "array",
        items: { type: "string" }
      },
      warnings: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: [
      "overallScore",
      "skillsScore",
      "requirementsScore",
      "responsibilitiesScore",
      "jobTitle",
      "company",
      "matchedSkills",
      "missingSkills",
      "requirements",
      "responsibilities",
      "recommendations",
      "warnings"
    ]
  }
} as const;

function parseOpenAIJson(text: string): AutofillResponse {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned) as AutofillResponse;
  return {
    fills: Array.isArray(parsed.fills) ? parsed.fills : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
  };
}

function parseAtsMatchJson(text: string): AtsMatchResponse {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned) as AtsMatchResponse;
  return {
    overallScore: clampScore(parsed.overallScore),
    skillsScore: clampScore(parsed.skillsScore),
    requirementsScore: clampScore(parsed.requirementsScore),
    responsibilitiesScore: clampScore(parsed.responsibilitiesScore),
    jobTitle: parsed.jobTitle || "",
    company: parsed.company || "",
    matchedSkills: Array.isArray(parsed.matchedSkills) ? parsed.matchedSkills : [],
    missingSkills: Array.isArray(parsed.missingSkills) ? parsed.missingSkills : [],
    requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [],
    responsibilities: Array.isArray(parsed.responsibilities) ? parsed.responsibilities : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
  };
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}
