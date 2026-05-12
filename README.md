# FillAI

An OpenAI-powered Chrome extension plus a local backend proxy for filling job applications.

The extension never stores an OpenAI API key. It sends page/form context to the API server, and the API server calls OpenAI with `OPENAI_API_KEY` from its environment.

## Quick Start

1. Install dependencies:

   ```sh
   npm install
   ```

2. Configure the API:

   ```sh
   cp apps/api/.env.example apps/api/.env
   ```

   Add your OpenAI API key to `apps/api/.env`.

3. Start the API:

   ```sh
   npm run dev:api
   ```

4. Build the Chrome extension:

   ```sh
   npm run build:extension
   ```

5. Load the extension:

   - Open `chrome://extensions`
   - Enable Developer mode
   - Click "Load unpacked"
   - Select `apps/extension/dist`

## How It Works

- The content script detects visible form fields on job application pages.
- The popup lets you save a candidate profile and trigger autofill.
- The extension sends field metadata, job page text, and your profile to the API.
- The API calls OpenAI and returns structured fill instructions.
- The content script applies values to text inputs, textareas, selects, checkboxes, radios, and file inputs where possible.

## Important

For production, deploy `apps/api` behind authentication, rate limiting, TLS, and audit logging. Never ship your OpenAI API key inside a Chrome extension.
