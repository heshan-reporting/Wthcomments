# API setup guide — every platform

Credentials for all six ad platforms, the AI, sign-in, and WhatsApp — where to
click, what to copy, what to name it, and how to prove it works.

Everything authenticated happens in the **Cloudflare Worker** (`worker.js`).
Tokens live there as encrypted secrets; the browser never sees them.

---

## How credentials reach the worker

There are two places a platform token can live:

| | Where | Lifetime | Use it for |
|---|---|---|---|
| **Worker secret** | Cloudflare → Worker → Variables and Secrets | Permanent, server-side, shared by every user | **Production. Always prefer this.** |
| **App Configuration** | In-app **Configuration** panel | That browser only (localStorage), per user | Quick tests, one person trying a platform |

**Worker secrets win.** If both exist for a platform, the worker uses its own
secret and ignores what the browser sent.

Auto-renewal (the OAuth `CLIENT_ID` + `CLIENT_SECRET` + `REFRESH_TOKEN` trios
for Google, LinkedIn, Pinterest, Reddit) **only works as worker secrets** — a
refresh token pasted into the app cannot be exchanged without the client secret
sitting on the worker.

---

## Quick reference — every secret

Add these at **dash.cloudflare.com → Workers & Pages → your worker → Settings →
Variables and Secrets**. Anything holding a token or secret should be added as
an **encrypted secret**, not a plaintext variable.

| Platform | Required | Optional / recommended | Console |
|---|---|---|---|
| **Worker auth** | `AUTH_SECRET` | — | you invent it |
| **Meta** | `META_ACCESS_TOKEN` | `META_AD_ACCOUNT_ID` | [business.facebook.com](https://business.facebook.com/settings/system-users) |
| **Google Ads** | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` | `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC), `GOOGLE_ADS_CUSTOMER_ID` | [API Center](https://ads.google.com/aw/apicenter) |
| **TikTok** | `TIKTOK_ACCESS_TOKEN` | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` (account discovery), `TIKTOK_ADVERTISER_ID` | [ads.tiktok.com/marketing_api/apps](https://ads.tiktok.com/marketing_api/apps/) |
| **LinkedIn** | `LINKEDIN_ACCESS_TOKEN` **or** the trio | `LINKEDIN_REFRESH_TOKEN` + `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_AD_ACCOUNT_ID`, `LINKEDIN_VERSION` | [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) |
| **Pinterest** | `PINTEREST_ACCESS_TOKEN` **or** the trio | `PINTEREST_REFRESH_TOKEN` + `PINTEREST_CLIENT_ID` + `PINTEREST_CLIENT_SECRET`, `PINTEREST_AD_ACCOUNT_ID` | [developers.pinterest.com/apps](https://developers.pinterest.com/apps/) |
| **Reddit** | `REDDIT_REFRESH_TOKEN` + `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `REDDIT_ACCESS_TOKEN` (tests only), `REDDIT_AD_ACCOUNT_ID` | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) |
| **AI** | `ANTHROPIC_API_KEY` | — | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **WhatsApp** | see [WHATSAPP-SETUP.md](WHATSAPP-SETUP.md) | | [developers.facebook.com](https://developers.facebook.com/apps) |
| **Sign-in** | Google Client ID (in-app, public) | — | [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) |

Nothing is mandatory except the worker itself — every platform is
feature-gated. Configure Meta only, and the app runs with Meta only.

API versions currently pinned in `worker.js`: Meta Graph `v21.0`, Google Ads
`v25`, TikTok `v1.3`, LinkedIn `202506`, Pinterest `v5`, Reddit `v3`.

---

## Step 1 — Deploy the worker

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** →
   **Create** → **Start with Hello World** → **Deploy**.
2. **Edit code** → delete the placeholder → paste all of `worker.js` → **Deploy**.
3. Note the URL: `https://ads-proxy.YOUR-NAME.workers.dev`.
4. **Settings → Variables and Secrets → Add** an encrypted secret:
   - `AUTH_SECRET` — any long random string you invent. Generate one with
     `openssl rand -hex 24`.
5. In the app: **Configuration → Worker URL** = that URL, **Worker Auth Token**
   = the same `AUTH_SECRET`.

The worker rejects every request whose `X-Auth-Token` header doesn't match
`AUTH_SECRET`. If you leave `AUTH_SECRET` unset the worker is **open to anyone
who finds the URL** — set it.

Redeploy the worker (repeat 2) whenever you pull a newer `worker.js`.

---

## Step 2 — Google Sign-In (app login)

This is user login, not ad data — separate from Google Ads below.

1. [console.cloud.google.com](https://console.cloud.google.com) → new or
   existing project.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID →
   Web application**.
3. **Authorised JavaScript origins** — add every origin you open the app from:
   - `https://YOUR-USERNAME.github.io` (GitHub Pages)
   - `http://localhost` (local testing)
4. Copy the Client ID (`123456789-xxxx.apps.googleusercontent.com`) into
   **Configuration → Google Client ID**.

The Client ID is public by design — it is safe in the HTML.

---

## Step 3 — AI key

[console.anthropic.com → API keys](https://console.anthropic.com/settings/keys)
→ **Create key**.

Add as a worker secret: **`ANTHROPIC_API_KEY`**. (`CLAUDE_KEY`,
`CLAUDE_API_KEY` and `ANTHROPIC_KEY` are accepted aliases.)

Keeping the key on the worker means it stays server-side. The app also accepts
a browser-side key in Configuration, but then it lives in that browser's
localStorage — fine for you, not for a shared deployment.

---

## Meta Ads (Facebook / Instagram)

**What you need:** a never-expiring system user token with `ads_read`.

### 1. Business app

[developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create
App** → type **Business** → link it to your Business Manager.

### 2. System user token

[business.facebook.com → Settings → Users → System Users](https://business.facebook.com/settings/system-users)

1. **Add** a system user (role: **Admin**), or reuse an existing one.
2. **Add Assets** → **Ad Accounts** → select every ad account you report on →
   grant at least **View performance**.
3. **Generate new token** → pick your app → tick:
   - `ads_read` — required
   - `ads_management` — only if you want pause / budget changes (see
     [Mutations](#optional-infrastructure))
   - `business_management` — lets the app discover accounts automatically
4. Copy the token immediately — it is shown once.

System user tokens don't expire. A **user** token from Graph Explorer expires in
1–2 hours; don't use one for anything but a smoke test.

### 3. Ad account ID

[business.facebook.com → Ad Accounts](https://business.facebook.com/settings/ad-accounts).
Format `act_1234567890`.

### 4. Secrets

| Secret | Value |
|---|---|
| `META_ACCESS_TOKEN` | the system user token |
| `META_AD_ACCOUNT_ID` | *(optional)* default account, `act_…` |

You can skip `META_AD_ACCOUNT_ID` — the app discovers every ad account the token
can see and builds the client roster from it.

**Verify:** [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)
should show **Expires: Never** and `ads_read` in the scopes.

---

## Google Ads

**What you need:** a developer token *plus* an OAuth refresh token. Two separate
approvals — this is the longest setup of the six.

### 1. Developer token

[Google Ads → Tools & Settings → API Center](https://ads.google.com/aw/apicenter)
— you must be signed into a **manager (MCC)** account; the API Center doesn't
exist on a standard account.

Apply for **Basic access**. A brand-new token starts at **Test account access**,
which returns `DEVELOPER_TOKEN_NOT_APPROVED` against real accounts. Approval is
usually 1–3 business days.

### 2. OAuth client

[console.cloud.google.com → APIs & Services](https://console.cloud.google.com/apis/credentials)

1. **Enable APIs → Google Ads API → Enable**.
2. **OAuth consent screen** → External → add yourself as a test user →
   then **Publish app**.
   > **Publish it.** While the consent screen is in *Testing*, refresh tokens
   > silently expire after **7 days** and Google Ads dies every week with
   > `invalid_grant`.
3. **Credentials → Create Credentials → OAuth client ID → Web application**.
4. Under **Authorised redirect URIs** add
   `https://developers.google.com/oauthplayground`.
5. Copy the **Client ID** and **Client secret**.

### 3. Refresh token

Easiest route — [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):

1. Gear icon (top right) → tick **Use your own OAuth credentials** → paste your
   Client ID and secret.
2. Left panel → scroll to the bottom → paste this scope into the "input your own
   scopes" box:
   ```
   https://www.googleapis.com/auth/adwords
   ```
3. **Authorise APIs** → sign in **as a Google account with access to the ad
   accounts** → allow.
4. **Exchange authorization code for tokens** → copy the **Refresh token**.

Script alternative (same result):

```js
npm install googleapis
const {google} = require('googleapis');
const o = new google.auth.OAuth2('CLIENT_ID','CLIENT_SECRET','urn:ietf:wg:oauth:2.0:oob');
console.log(o.generateAuthUrl({access_type:'offline', prompt:'consent',
  scope:['https://www.googleapis.com/auth/adwords']}));
// visit the URL, approve, paste the code back:
const {tokens} = await o.getToken('CODE');
console.log(tokens.refresh_token);
```

### 4. Customer IDs

Both are the 10-digit ID **without dashes** (`3219604662`, not `321-960-4662`).

- **Customer ID** — the account you query. In-app: **Configuration → Customer ID**.
- **Login Customer ID** — your **MCC** ID, if the account sits under a manager.

### 5. Secrets

| Secret | Value |
|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | from API Center |
| `GOOGLE_ADS_CLIENT_ID` | OAuth client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | from the Playground |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC ID, no dashes — **set this if you use an MCC** |
| `GOOGLE_ADS_CUSTOMER_ID` | *(optional)* default account |
| `GOOGLE_ADS_API_VERSION` | *(optional)* e.g. `v25` — overrides the pinned version |

> **Google retires each API version about a year after release**, and calls to a
> retired one come back as an HTML 404 page rather than an API error, so it
> reads like a broken endpoint rather than an expired version. When that
> happens, set `GOOGLE_ADS_API_VERSION` to a current version — a variable
> change, no redeploy of `worker.js`. Check the current versions on Google's
> [sunset dates](https://developers.google.com/google-ads/api/docs/sunset-dates)
> page.

> `GOOGLE_ADS_LOGIN_CUSTOMER_ID` missing is the single most common Google
> failure — client accounts under an MCC return `USER_PERMISSION_DENIED` / 401
> without it.

---

## TikTok Ads

**What you need:** a long-lived access token, and the app ID/secret if you want
advertiser discovery.

### 1. Developer app

[ads.tiktok.com/marketing_api/apps](https://ads.tiktok.com/marketing_api/apps/)
→ **Create an App** (or open an existing one).

- Type: **Marketing API**
- Permissions: **Ad Account Management (Read)** and **Reporting (Read)**
  (add the write scopes only if you want mutations)
- **Advertiser redirect URL**: any HTTPS URL you control. Nothing has to run
  there — TikTok only appends a code to it and you read that code out of your
  browser's address bar. `https://example.com/callback` is fine.

From **Basic Information**, copy the **App ID** and the **Secret**.

### 2. Authorise and get the token

The token isn't handed to you on a page — you authorise an ad account, TikTok
redirects back with a one-time code, and you trade that code for the token.

**a. Open the authorisation URL.** The app's page shows a generated one; copy it.
If you'd rather build it yourself, the shape is:

```
https://business-api.tiktok.com/portal/auth?app_id=YOUR_APP_ID&state=xyz&redirect_uri=YOUR_URL_ENCODED_REDIRECT
```

`redirect_uri` must be URL-encoded and match the redirect URL on the app exactly
— trailing slash included. `state` is any string you choose; it comes back
unchanged.

**b. Approve.** Sign in as the person who owns (or is admin on) the ad accounts
and tick the advertisers you want this app to read.

**c. Read the code off the address bar.** You land back on your redirect URL:

```
https://example.com/callback?auth_code=abc123def456&code=abc123def456&state=xyz
```

A browser error page there is fine — nothing needs to be listening.

TikTok appends **both `auth_code` and `code`**, usually carrying the same
string. Take **`auth_code`** — that is the field the token endpoint expects.

The code is a **40-character hex string**, and hand-selecting it from the
address bar loses a character depressingly often. Rather than select it, copy
the whole redirect URL and let the shell cut it out:

```bash
URL='PASTE_THE_ENTIRE_REDIRECT_URL_HERE'
CODE=$(printf '%s' "$URL" | sed -n 's/.*[?&]auth_code=\([^&]*\).*/\1/p')
echo "code: $CODE  (${#CODE} chars — expect 40)"
```

If that count is not 40 the copy is short — recopy the URL rather than
spending an `auth_code` on it.

**d. Exchange it, straight away.** The code is single-use and expires in minutes:

Set the three values, then send them. Keep this in the same terminal as the
extractor above, so `$CODE` is still set:

```bash
APP_ID='YOUR_APP_ID'
SECRET='YOUR_APP_SECRET'
echo "app_id:${#APP_ID}  secret:${#SECRET}  code:${#CODE}"
```

That last line prints lengths, not values — expect roughly 19 / 40 / 40. A
`code:0` means you are in a fresh shell; re-run the extractor.

```bash
curl -X POST 'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/' -H 'Content-Type: application/json' -d "$(printf '{"app_id":"%s","secret":"%s","auth_code":"%s"}' "$APP_ID" "$SECRET" "$CODE")"
```

`printf` assembles the JSON from the variables, so the command carries no
escaped quotes and no literal credentials for a stray paste to overwrite.
Two failures this shape avoids:

- Pasting a command whose lines end in `\` often flattens them to `\ `
  (backslash-space), which escapes the space instead of continuing the line.
  curl never sees `-d`, sends no body, and TikTok answers `40002 request body
  is required but missing`, followed by `URL rejected` errors as curl treats
  the leftover JSON as more URLs.
- Pasting over a `\"auth_code\":` key inside an escaped JSON string replaces
  the key rather than the value, and TikTok answers `40002 auth_code: Missing
  data for required field`.

Exactly three fields — TikTok's Marketing API takes no `grant_type` here (that
belongs to the separate TikTok *Developer* API for consumer apps).

A success looks like:

```json
{"code":0,"message":"OK","data":{
  "access_token":"1a2b3c…",
  "advertiser_ids":["7123456789012345678"],
  "scope":[...]}}
```

`"code":0` means success — anything else is an error, and `message` says what.
The `access_token` **does not expire** unless revoked. `advertiser_ids` lists
the advertisers you just authorised.

`40002 · the input data is invalid for the associated parameter` means the
request was well-formed but a value was rejected — nearly always the
`auth_code`: already used, expired, or short a character. Check its length,
then redo (a) through (d); they're cheap to repeat.

Using `$CODE` from the extractor above needs **double** quotes on `-d` so the
variable expands — single quotes send the literal text `$CODE`.

Shortcut for a single account: **TikTok Ads Manager → Tools → API** also issues a
long-lived token, but it can't do advertiser discovery.

### 3. Advertiser ID

[TikTok Ads Manager](https://ads.tiktok.com) → **Account info**. A 19-digit
number like `7123456789012345678`.

### 4. Secrets

| Secret | Value |
|---|---|
| `TIKTOK_ACCESS_TOKEN` | the long-lived token |
| `TIKTOK_APP_ID` | App ID — **needed to list advertisers** |
| `TIKTOK_APP_SECRET` | App secret — same |
| `TIKTOK_ADVERTISER_ID` | *(optional)* default advertiser |

Without `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` the token still reports fine, but
the client roster can't enumerate TikTok accounts — you'd set each advertiser ID
by hand in `CLIENTS_JSON`.

---

## LinkedIn Ads

**What you need:** Marketing Developer Platform access on your app, then a token
with `r_ads` and `r_ads_reporting`.

### 1. App + API access

[linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) →
**Create app** → attach it to your **company page** → verify the page (the app
stays unusable until an admin clicks the verification link).

Then **Products** tab → request **Advertising API** (Marketing Developer
Platform). This is a **manual review** — days, sometimes longer, and it asks
what you'll build. Nothing below works until it's approved.

### 2. Token

**Auth** tab → **OAuth 2.0 tools** →
[token generator](https://www.linkedin.com/developers/tools/oauth/token-generator)
→ select scopes:

- `r_ads` — campaign structure
- `r_ads_reporting` — analytics
- `rw_ads` — only if you want mutations

Access tokens last **60 days**. The generator also returns a **refresh token**
(valid ~365 days) — take it, or you'll be re-pasting a token every two months.

### 3. Ad account ID

[Campaign Manager](https://www.linkedin.com/campaignmanager/accounts) — the
number in the URL `.../campaignmanager/accounts/{id}/`. Numeric only, no
`urn:li:sponsoredAccount:` prefix.

### 4. Secrets

| Secret | Value |
|---|---|
| `LINKEDIN_ACCESS_TOKEN` | 60-day token |
| `LINKEDIN_REFRESH_TOKEN` | refresh token — **for unattended operation** |
| `LINKEDIN_CLIENT_ID` | from the Auth tab |
| `LINKEDIN_CLIENT_SECRET` | from the Auth tab |
| `LINKEDIN_AD_ACCOUNT_ID` | *(optional)* default account |
| `LINKEDIN_VERSION` | *(optional)* API version, defaults to `202506` |

The refresh **trio** (`REFRESH_TOKEN` + `CLIENT_ID` + `CLIENT_SECRET`) on its own
is a complete configuration — the worker mints an access token when it needs
one. That is the setup you want.

---

## Pinterest Ads

**What you need:** an app with `ads:read`, then a token for your ad account.

### 1. App

[developers.pinterest.com/apps](https://developers.pinterest.com/apps/) →
**Create app** (needs a Pinterest **business** account).

- Scopes: `ads:read` (add `ads:write` for mutations)
- Redirect URI: an HTTPS URL you control

Copy the **App ID** and **App secret key**.
Docs: [Set up your app](https://developers.pinterest.com/docs/getting-started/set-up-app/).

**Trial vs standard access:** a new app has *trial* access — enough to read
**your own** ad accounts, which is all this app needs. Reporting on accounts you
don't own requires standard access (app review).

### 2. Token

1. Send the account owner to:
   ```
   https://www.pinterest.com/oauth/?client_id=APP_ID&redirect_uri=YOUR_URI&response_type=code&scope=ads:read
   ```
2. Approve → copy `?code=…` from the redirect.
3. Exchange it:

```bash
curl -X POST 'https://api.pinterest.com/v5/oauth/token' -u 'APP_ID:APP_SECRET' -d 'grant_type=authorization_code' -d 'code=CODE' -d 'redirect_uri=YOUR_URI'
```

Access token lives ~30 days; the refresh token ~1 year.

### 3. Ad account ID

[ads.pinterest.com](https://ads.pinterest.com) — in the URL
`ads.pinterest.com/advertiser/{id}/`. Numeric, e.g. `549812345678`.

### 4. Secrets

| Secret | Value |
|---|---|
| `PINTEREST_ACCESS_TOKEN` | access token |
| `PINTEREST_REFRESH_TOKEN` | refresh token — **for unattended operation** |
| `PINTEREST_CLIENT_ID` | App ID |
| `PINTEREST_CLIENT_SECRET` | App secret |
| `PINTEREST_AD_ACCOUNT_ID` | *(optional)* default account |

The worker refreshes on a 401 when the client pair is present. Without them, the
token dies in 30 days and Pinterest goes quiet.

> Pinterest returns spend in micro-dollars. The worker converts it — every
> `*_IN_MICRO_DOLLAR` field gets a plain-currency twin alongside it, so nothing
> downstream divides by a million twice.

---

## Reddit Ads

**What you need:** a Reddit app, ads API allow-listing, and a **permanent**
refresh token. Reddit access tokens die in 24 hours — the refresh token is the
whole setup.

### 1. App

[reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → **create another
app…**

- Type: **web app**
- Redirect URI: an HTTPS URL you control

The **client ID** is the short string under the app name; the **secret** is
labelled `secret`.

### 2. Ads API access

Reddit allow-lists Ads API access per account. If you're not already enabled,
ask your Reddit Ads rep or apply through
[ads.reddit.com](https://ads.reddit.com) → Help. Without it, calls return 403
even with a perfectly valid token.

### 3. Permanent refresh token

1. Authorise — note **`duration=permanent`**, which is what makes Reddit issue a
   refresh token at all:
   ```
   https://www.reddit.com/api/v1/authorize?client_id=CLIENT_ID&response_type=code&state=x&redirect_uri=YOUR_URI&duration=permanent&scope=adsread%20history%20read
   ```
   Add `adsedit` to the scope list if you want mutations.
2. Approve → copy `?code=…`.
3. Exchange:

```bash
curl -X POST 'https://www.reddit.com/api/v1/access_token' -u 'CLIENT_ID:CLIENT_SECRET' -A 'cmm-ads-intelligence/1.0' -d 'grant_type=authorization_code' -d 'code=CODE' -d 'redirect_uri=YOUR_URI'
```

Keep the **`refresh_token`**. (Reddit rejects requests without a `User-Agent`,
hence `-A`.)

### 4. Ad account ID

[ads.reddit.com](https://ads.reddit.com) → Account settings, or read it out of
the URL `ads.reddit.com/dashboard?account={id}`. Looks like `t2_abc123`.

### 5. Secrets

| Secret | Value |
|---|---|
| `REDDIT_REFRESH_TOKEN` | **the important one** |
| `REDDIT_CLIENT_ID` | from prefs/apps |
| `REDDIT_CLIENT_SECRET` | from prefs/apps |
| `REDDIT_ACCESS_TOKEN` | *(optional)* 24-hour token, tests only |
| `REDDIT_AD_ACCOUNT_ID` | *(optional)* default account |

Setting only `REDDIT_ACCESS_TOKEN` works until tomorrow, then stops. Set the
trio.

---

## WhatsApp digests

Scheduled spend digests and two-way Q&A over WhatsApp have their own guide:
**[WHATSAPP-SETUP.md](WHATSAPP-SETUP.md)** — Business account, permanent token,
`ads_update` template, webhook, cron.

Secrets: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_RECIPIENTS`,
`WHATSAPP_VERIFY_TOKEN`, plus optional `WHATSAPP_ALLOWED`,
`WHATSAPP_DIGEST_DAYS`, `WHATSAPP_TEMPLATE`, `WHATSAPP_TEMPLATE_LANG`,
`WHATSAPP_MODEL`.

---

## Optional infrastructure

All feature-gated — the worker runs fine without any of it.

### KV storage — `ADS_KV`

Enables the query cache, daily spend history, monitoring baselines, and the
mutation audit log.

Cloudflare dash → **Storage & Databases → KV → Create namespace** → then your
worker → **Settings → Bindings → Add → KV namespace**, variable name exactly
**`ADS_KV`**.

### Cache

`CACHE_TTL` — query cache lifetime in seconds, default `900` (15 min), floor 60.

### Mutations

`ALLOW_MUTATIONS` = `true` turns on pause / enable / budget changes. Off by
default; the app is read-only until you set it.

`MUTATION_MAX_BUDGET` — hard cap on any budget a mutation may set. Set it.

Mutations also need write scope on the platform token: Meta `ads_management`,
Google (same OAuth), TikTok write permissions, LinkedIn `rw_ads`, Pinterest
`ads:write`, Reddit `adsedit`.

### Client roster — `CLIENTS_JSON`

The worker discovers accounts automatically. Override that — or pin
cross-platform accounts to one client, or set budgets — with a plaintext
variable:

```json
[{"name":"Acme",
  "meta":{"act":"act_123"},
  "google":{"cid":"3219604662"},
  "tiktok":{"adv":"7123456789012345678"},
  "linkedin":{"acct":"512345678"},
  "pinterest":{"acct":"549812345678"},
  "reddit":{"acct":"t2_abc123"},
  "monthlyBudget":15000}]
```

`monthlyBudget` (in account currency) is what enables budget-exhaustion
forecasts.

---

## How accounts become clients

The app keeps a **client roster**: every ad account the worker's credentials
can reach, grouped by client name. The AI's `list_clients` tool reads it, and
every "across all clients" question fans out over it. It refreshes itself:

- **automatically each time the app opens** — throttled to 30 minutes, and
  always after an app update or a run that hit errors;
- on demand: **Configuration → Discover clients from connected accounts**.

So after adding a platform's secrets and redeploying the worker, just reopen
the app. Accounts that share a name across platforms — `Acme (CMM Billing)` on
Google, `ACME` on TikTok — merge into one client; the trailing bracket and the
case are ignored. Anything that doesn't match becomes a client of its own, so
nothing the credentials can see is ever hidden. Rename or merge clients by hand
in the same panel.

A client that points Google at the **manager (MCC)** id is cleared during
discovery: managers hold no ads and can never return metrics, and the child
accounts arrive as clients of their own. Discovery looks through the MCC using
whichever of these it has: the **Manager Account ID** in Configuration, or the
`GOOGLE_ADS_LOGIN_CUSTOMER_ID` worker secret. With neither, Google only lists
the handful of customers the OAuth user touches directly, without names, and
the note under the Discover button says so.

If a platform still shows as not connected, the note under the Discover button
says exactly what failed, in the platform's own words.

## Verify everything

**Configuration → Connection Doctor → Run.**

It makes the cheapest authenticated call each platform offers and reports one of:

- **ok** — with what it saw ("3 ad account(s) reachable")
- **skip** — nothing configured for that platform, which is fine
- **error** — the platform's own message, plus a suggested fix

It also reports the worker version (`3.1.0` at the time of writing) so you can
tell a stale deployment from a credential problem. If the version is behind,
redeploy `worker.js` before debugging anything else.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| A platform says "No clients configured" or "not connected" while Connection Doctor is green | The roster hasn't refreshed since those credentials went in. Reopen the app, or click **Discover clients**; the note under the button names any failure |
| `Unauthorized` on every call | Worker Auth Token in the app ≠ `AUTH_SECRET` on the worker |
| Google `DEVELOPER_TOKEN_NOT_APPROVED` | Token still has test-account access — apply for Basic in API Center |
| Google `USER_PERMISSION_DENIED` / 401 | Set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to your MCC ID (no dashes), and confirm the MCC links the client account |
| Google `CUSTOMER_NOT_FOUND` | Use the 10-digit ID without dashes |
| Google `REQUESTED_METRICS_FOR_MANAGER`, or a client returns no metrics | That client points at a manager (MCC) id. Managers run no ads — point it at a **child** account id, keeping the MCC in `GOOGLE_ADS_LOGIN_CUSTOMER_ID`. Check `CLIENTS_JSON` first: it overrides discovery, which already skips managers |
| Google 404, HTML error page, both accounts fail identically | The pinned API version is retired — set `GOOGLE_ADS_API_VERSION` to a current version |
| Google `invalid_grant` | Refresh token revoked — usually the consent screen is still in *Testing* (7-day expiry). Publish it, mint a new token |
| Meta "token expired/invalid" | You used a user token — generate a **system user** token instead |
| Meta token valid, no accounts | System user has no ad account assets, or is missing `ads_read` |
| TikTok `40105` / `40102` | Token invalid or expired — regenerate |
| TikTok `40104` | Token lacks permission on that advertiser — re-authorise with the right Business Center |
| TikTok "Set TIKTOK_APP_ID and TIKTOK_APP_SECRET" | Advertiser discovery needs the app pair, not just the token |
| LinkedIn 401 | Access token past 60 days — add the refresh trio so it renews itself |
| LinkedIn 403 | Missing `r_ads`, or the app doesn't have Advertising API access approved |
| Pinterest 401 | Token past ~30 days — set `PINTEREST_REFRESH_TOKEN` + client ID/secret |
| Reddit works one day, fails the next | You set only `REDDIT_ACCESS_TOKEN`. Set the refresh trio |
| Reddit `refresh failed` | Check client ID/secret, and that the token was minted with `duration=permanent` and the `adsread` scope |
| Reddit 403 with a valid token | Account isn't allow-listed for the Ads API |
| Platform returns stale numbers | The cache — re-run with fresh data, or lower `CACHE_TTL` |
| "Unknown source" errors | Worker running old code — redeploy `worker.js` |

---

## Setup order that works

1. Worker + `AUTH_SECRET` → app can reach the proxy
2. `ANTHROPIC_API_KEY` → chat works
3. Google Sign-In Client ID → login works
4. **Meta** — fastest platform to get live
5. **Google Ads** — start the developer token application early, it's the long pole
6. TikTok / LinkedIn / Pinterest / Reddit — as needed
7. `ADS_KV` → caching and history
8. WhatsApp digests
9. `ALLOW_MUTATIONS` last, with `MUTATION_MAX_BUDGET` set

Run Connection Doctor after each step rather than at the end — it names the
platform and the fix, which beats guessing from an empty dashboard.
