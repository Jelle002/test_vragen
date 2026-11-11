# Kamervragen-quiz

A quiz about written questions from members of the Dutch parliament (Tweede Kamer):

1. **Googlebaar?** Visitors guess whether the answer was already findable online before the question was asked.
2. **Slim of dom?** For answered questions they read a summary of the cabinet's answer and vote smart or dumb.

New questions are imported automatically from the Tweede Kamer open data, Claude writes a **draft** assessment,
and nothing appears in the quiz until an admin has checked and published it.

## Privacy

- Visitors don't log in. The site uses no cookies, no localStorage and no analytics, and fonts and libraries are self-hosted.
- A vote only increments an anonymous counter per question (`totalen` table). Nothing is stored per visitor.
- The database enforces this: anonymous users can't read or write any table, only call `quiz_ronde()` (published questions, public fields only) and `stem()` (increments a counter).
- Hosting providers (GitHub Pages, Supabase) keep their own server logs, including IP addresses. The site footer says so.

## Structure

```
site/                         static website (GitHub Pages)
  index.html, js/quiz.js      the quiz
  admin.html, js/admin.js     admin: login (+ optional 2FA), review, publish
  js/config.js                Supabase URL + anon key (filled in by the deploy workflow)
supabase/
  migrations/…_kamervragen_quiz.sql   tables, security rules, public functions
  functions/import-kamervragen/       Edge Function: import + Claude draft
  cron.sql                            optional daily schedule
.github/workflows/pages.yml   deploys site/ to GitHub Pages
```

## Setup

See the step-by-step guide below ("Setup: Supabase + GitHub Pages").

### Setup: Supabase + GitHub Pages

**A. Database**
1. Supabase dashboard → your project → **SQL Editor** → New query.
2. Paste the contents of `supabase/migrations/20261111000000_kamervragen_quiz.sql` and click **Run**.

**B. Admin account**
1. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up" (so nobody else can create an account).
2. **Authentication → Users → Add user → Create new user**: your email + a strong password, tick "Auto Confirm User".
3. Copy the new user's **UID**, then in the SQL Editor run:
   ```sql
   insert into public.admins (user_id) values ('PASTE-UID-HERE');
   ```

**C. Edge Function (import + AI)**

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from the repository root:
```bash
supabase login
supabase link --project-ref <PROJECT-REF>
supabase secrets set ANTHROPIC_API_KEY=<your Anthropic API key> IMPORT_SECRET=<long random string>
supabase functions deploy import-kamervragen --no-verify-jwt
```
`<PROJECT-REF>` is the part before `.supabase.co` in your project URL. Generate a random secret with e.g. `openssl rand -hex 32`.

Optional secrets: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `MAX_AI_PER_RUN` (default 3), `ZAKEN_PER_RUN` (50),
`IMPORT_DAGEN` (30), `ALLOWED_ORIGIN` (e.g. `https://<user>.github.io` to restrict CORS).

**D. Daily automatic import (optional)**

Open `supabase/cron.sql`, replace `<PROJECT-REF>` and `<IMPORT-SECRET>`, and run it in the SQL Editor.
Without it you can still import by clicking **"Nieuwe vragen ophalen"** on the admin page.

**E. GitHub Pages**
1. Supabase → **Project Settings → API**: copy the **Project URL** and the **anon / publishable** key (never the service_role key).
2. GitHub repo → **Settings → Secrets and variables → Actions → Variables** tab → add
   `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. GitHub repo → **Settings → Pages** → Source: **GitHub Actions**.
4. Merge this branch into `main` (the workflow deploys on pushes to `main` that touch `site/`), or run
   **Actions → "Publiceer op GitHub Pages" → Run workflow**.
5. The quiz is at `https://<user>.github.io/<repo>/`, the admin page at `…/admin.html`.

**F. First run**
1. Open `admin.html`, log in, click **"2FA instellen"** (recommended), and scan the QR code.
2. Click **"Nieuwe vragen ophalen"** (up to 3 new questions per click/run get an AI draft).
3. Open a concept, check everything, tick "Ik heb alles gecontroleerd", and click **Publiceren**.

## Without an API key: "Beoordelen via Claude.ai"

The Anthropic API is billed separately from a Claude Pro subscription. If you don't set `ANTHROPIC_API_KEY`,
the import still fetches questions (up to 20 per run, `MAX_IMPORT_PER_RUN`) without an AI draft. On the admin page,
**"Beoordelen via Claude.ai"** builds one prompt for up to 30 open questions. You paste it into claude.ai (with web
search on) and paste Claude's JSON answer back. The page validates it and stores it as the AI draft for each question.
Review and publish as usual.

## How the review works

- The import only ever creates **concepts**. The AI draft is stored separately (`ai_concept`) and pre-fills empty fields.
- The database refuses to publish if the googlebaar verdict, explanations, summary or score are missing
  (and the answer summary, for answered questions).
- When an answer arrives for a question that's already published, it's flagged **"Herzien nodig"**. The
  "slim of dom" step only shows once you tick "De vraag is beantwoord" and publish again.
- If an admin account has 2FA, the database only grants admin rights after the 2FA code (`aal2`).

## Local testing

Fill in `site/js/config.js`, then run `python3 -m http.server -d site 8000` and open http://localhost:8000.
