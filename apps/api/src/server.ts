import cors from "@fastify/cors";
import "dotenv/config";
import Fastify from "fastify";
import OpenAI from "openai";
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
const app = Fastify({ logger: true });
const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const candidateProfileSchema = z.object({
  fullName: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  location: z.string().default(""),
  linkedin: z.string().default(""),
  portfolio: z.string().default(""),
  resumeText: z.string().default(""),
  workAuthorization: z.string().default(""),
  sponsorship: z.string().default(""),
  salaryExpectation: z.string().default(""),
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
    .default([])
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

type AutofillResponse = {
  fills: Array<{
    id: string;
    value: string | boolean;
    confidence: number;
    reason?: string;
  }>;
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
      "You are a careful job application autofill assistant. Use the candidate profile as the source of truth. Do not invent credentials, degrees, employers, dates, salaries, immigration status, protected-class information, or legal claims. If a field needs a document upload or information is missing, omit the fill and add a warning.",
    input: [
      {
        role: "user",
        content: buildAutofillPrompt(parsed.data)
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

app.listen({ port: config.PORT, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

function buildAutofillPrompt(input: z.infer<typeof autofillRequestSchema>): string {
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
- Do not claim the user has experience or authorization that is not in the profile.
- Keep long-answer responses under 120 words unless the field clearly asks for a cover-letter-like answer.

Candidate profile:
${JSON.stringify(input.profile, null, 2)}

Job context:
${JSON.stringify(input.jobContext, null, 2)}

Fields:
${JSON.stringify(input.fields, null, 2)}`;
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
