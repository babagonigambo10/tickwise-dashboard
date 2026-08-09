# Tickwise — MEXC Penny-Jump Bot Dashboard (Frontend)

React + Vite + Tailwind dashboard, deployed to Vercel. Talks to Supabase
for auth/data and to the Railway orchestrator (see the sibling
`mexc-multiuser-bot` project) for starting/stopping bots.

## What's in here
- `src/App.jsx` — auth screen, config form, credentials form, live status + log feed
- `api/save-credentials.js` — Vercel function: encrypts and stores a user's MEXC keys
- `api/start-bot.js` / `api/stop-bot.js` — Vercel functions: authenticate the user,
  then call the Railway orchestrator's internal API (keeps `INTERNAL_API_TOKEN`
  and the encryption key server-side, never shipped to the browser)

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Environment variables
Copy `.env.example` to `.env.local` and fill in:
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — from Supabase Project Settings → API
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — same project, service role key (server-side only)
- `ENCRYPTION_KEY` — must match the orchestrator's Railway value exactly (see orchestrator README)
- `INTERNAL_API_TOKEN` — must match the orchestrator's Railway value exactly
- `ORCHESTRATOR_URL` — your deployed Railway orchestrator's public URL

### 3. Run locally
```bash
npm run dev
```

### 4. Deploy to Vercel
1. Push this folder to a GitHub repo (can be public — no secrets live in the code, only in env vars).
2. Vercel → New Project → import the repo.
3. Add every variable from `.env.example` under Project Settings → Environment Variables.
4. Deploy. Vercel auto-detects the Vite build and the `api/` folder as serverless functions.

## Order of operations across the whole project
This frontend depends on the orchestrator being deployed first (it needs
`ORCHESTRATOR_URL`), and the orchestrator depends on Supabase being set up
first (it needs the schema and Auth enabled). See the top-level step-by-step
for the full sequence across all three pieces.
