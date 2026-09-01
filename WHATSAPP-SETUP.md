# WhatsApp updates — setup guide

Send scheduled ad digests to WhatsApp, and let your team ask questions back.
All sending happens in the Cloudflare Worker; nothing is exposed in the browser.

---

## What you get

| | |
|---|---|
| **Scheduled digest** | Spend per client with day-on-day change and CTR, totalled per currency, pushed on a cron schedule. |
| **Two-way Q&A** | Someone messages your WhatsApp number — "how did Nationals do last week?" — and the worker answers using live ad data. |
| **`digest` keyword** | Messaging `digest` (or `report` / `summary`) returns the current digest on demand. |

---

## Step 1 — Create the WhatsApp Business Account

1. Go to **developers.facebook.com** → **My Apps** → the app you already use for Ads (or create a new **Business** app).
2. In the left sidebar choose **Add product → WhatsApp → Set up**.
3. Pick the **Meta Business Account** you use for the ad accounts.
4. Meta gives you a **test number** immediately — enough to try everything before registering a real one.

**Copy these two values** from *WhatsApp → API Setup*:

- **Phone number ID** (a long number under the "From" phone number — **not** the phone number itself)
- **WhatsApp Business Account ID** (needed only for templates)

> Registering your *own* number later: it must not be active on the normal
> WhatsApp app. If it is, delete that WhatsApp account first, or use a fresh number.

---

## Step 2 — Create a permanent access token

The token shown on the API Setup page expires in 24 hours. For production:

1. **business.facebook.com** → **Settings** → **Users → System Users**.
2. Use your existing system user (the one with the Ads token) or **Add** a new one.
3. **Add Assets** → select the **WhatsApp Account** → grant **Full control**.
4. **Generate new token** → choose the app → select these permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copy the token — it is shown **once**. This is your `WHATSAPP_TOKEN`.

---

## Step 3 — Add the worker secrets

**dash.cloudflare.com → Workers & Pages → `ads-proxy` → Settings → Variables and Secrets.**
Add each as an **encrypted secret**:

| Name | Value |
|---|---|
| `WHATSAPP_TOKEN` | the permanent token from Step 2 |
| `WHATSAPP_PHONE_ID` | Phone number ID from Step 1 |
| `WHATSAPP_RECIPIENTS` | who receives digests, E.164, comma separated — `+61400000001,+61400000002` |
| `WHATSAPP_VERIFY_TOKEN` | any string you invent (e.g. `cmm-ads-2026`) — used once in Step 5 |
| `WHATSAPP_ALLOWED` | *(optional)* numbers allowed to ask questions; defaults to `WHATSAPP_RECIPIENTS` |
| `WHATSAPP_DIGEST_DAYS` | *(optional)* `1` = yesterday (default), `7` = last week |

Then **deploy the current `worker.js` from this repo** if you haven't already.

---

## Step 4 — Submit the message template

Meta only allows **unprompted** business messages using a pre-approved template.
(Replies within 24 hours of someone messaging you need no template.)

**business.facebook.com → WhatsApp Manager → Message templates → Create template**

- **Name:** `ads_update`
- **Category:** **Utility**
- **Language:** English
- **Body:**

```
Ads update — {{1}}

Total: {{2}}

{{3}}
```

- **Sample values** (required for review):
  - `{{1}}` → `Yesterday · 2026-08-31`
  - `{{2}}` → `AUD 2,000 (▲12% vs prior)`
  - `{{3}}` → `• Nationals: AUD 1,200 ▲8% · CTR 2.40%`

Approval usually takes minutes to a few hours. If you name it something other
than `ads_update`, add a `WHATSAPP_TEMPLATE` secret with your name.

---

## Step 5 — Point the webhook at the worker (for two-way Q&A)

1. **developers.facebook.com → your app → WhatsApp → Configuration → Webhook → Edit**
2. **Callback URL:** your worker URL with `/whatsapp` on the end:
   ```
   https://ads-proxy.YOUR-NAME.workers.dev/whatsapp
   ```
3. **Verify token:** exactly the `WHATSAPP_VERIFY_TOKEN` you set in Step 3.
4. Click **Verify and save** — it should succeed immediately.
5. Under **Webhook fields**, subscribe to **`messages`**.

Skip this step if you only want scheduled digests.

---

## Step 6 — Schedule the digest

**Cloudflare dashboard → `ads-proxy` → Settings → Triggers → Cron Triggers → Add.**

Cron runs in **UTC**, so convert your local time:

| You want | Cron (UTC) |
|---|---|
| 08:00 AEST (UTC+10) daily | `0 22 * * *` |
| 09:00 AEST weekdays | `0 23 * * 0-4` |
| 08:00 UK (GMT) daily | `0 8 * * *` |

Weekday cron shifts the day field too, because 09:00 Tuesday AEST is 23:00
Monday UTC.

---

## Step 7 — Test it

In the app: **Configuration → WhatsApp updates**

- **Preview digest** — shows exactly what will be sent, without sending. Works
  as soon as the worker is deployed; needs no WhatsApp setup at all.
- **Send test message** — sends a real message. Free-form text only arrives if
  that number messaged your WhatsApp number in the last 24 hours; otherwise
  message your business number first, then retry.

Then message your WhatsApp number `digest` and you should get the summary back.

---

## Notes worth knowing

- **Opt-in is required.** Recipients must have agreed to receive messages from
  your business. For your own staff that is a formality, but it is Meta policy.
- **Cost.** Meta charges per conversation/message and pricing varies by country
  and category — check current WhatsApp pricing before sending to a long list.
- **The 24-hour window.** After anyone messages you, you can reply with
  free-form text for 24 hours. Outside it, only templates.
- **Client roster.** The worker discovers your Meta ad accounts automatically.
  To control the list (or include Google/TikTok/LinkedIn ids), add a
  `CLIENTS_JSON` variable:
  ```json
  [{"name":"Nationals","meta":{"act":"act_123"},"google":{"cid":"4567890123"}}]
  ```

---

## If something doesn't work

| Symptom | Cause |
|---|---|
| Webhook verification fails | `WHATSAPP_VERIFY_TOKEN` mismatch, or the URL is missing `/whatsapp` |
| `(#132000) template does not exist` | Template not approved yet, or the name/language doesn't match |
| `(#131030) recipient not in allowed list` | Test numbers must be added under WhatsApp → API Setup → *To* |
| Message accepted but never arrives | Outside the 24-hour window and not sent as a template |
| Digest is empty | The Meta token can't see any ad accounts — check its permissions |
| "Unknown source: whatsapp_digest" | The worker still runs the old code — redeploy `worker.js` |
