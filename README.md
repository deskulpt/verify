# Biz Verify

Check that a business exists, and is still active, by name or registration number. One form (or one API call) runs every free official registry for the chosen country automatically, then lists the registries that need a human (CAPTCHA or no API) as one-click links with your data ready to paste.

No dependencies. Plain Node 22.13+ (uses built-in `fetch`, `node:sqlite`, `node:test`).

## Quick start

```bash
git clone https://github.com/deskulpt/verify.git && cd verify
echo "API_KEY=$(openssl rand -hex 24)" > .env
node --env-file=.env server.mjs
```

Open http://localhost:3000.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `API_KEY` | for `/v1` | Shared secret for the `/v1` API (`x-api-key` header). Unset = `/v1` refuses every request. |
| `CONTACT_EMAIL` | for SEC | SEC EDGAR requires a contact in the User-Agent. Unset = SEC source shows an error, others still run. |
| `PORT` | no | Default `3000`. |
| `DB_FILE` | no | SQLite history file. Default `data/bizverify.db`. |

Keep `.env` out of git (already in `.gitignore`).

## Using the web form

1. Pick the country. Fields adapt (India shows "Registered exporter" and IEC).
2. Enter the legal name. Add the registration number and/or VAT/tax number if you have them: a matching number raises confidence, and some sources (EU VIES, Brazil CNPJ) need one.
3. Click **Verify**.

You get:

- **Summary banner**: Verified (high or medium confidence), Found but inactive, or Not verified automatically.
- **Verified automatically**: one card per registry.
  - VERIFIED (green): name (and number, if given) matches an active record.
  - INACTIVE (amber): record found but dissolved, merged, withdrawn, etc.
  - NOT FOUND: with up to 5 close matches.
  - SKIPPED / ERROR: missing required number, or the registry was unreachable.
- **Verify manually**: sites that need a CAPTCHA or forbid automation. **Open in new tab** opens the site (prefilled via URL where the site supports it) and copies the first field to your clipboard. **Copy** buttons cover the rest.

Only sources for the chosen country (plus global ones) are shown.

## API

`POST /v1/verify` (requires `x-api-key`). Body: the form fields plus an optional `ref` (your customer id, max 100 chars). With `ref`, the result is saved to history.

```bash
curl -s -X POST localhost:3000/v1/verify \
  -H 'content-type: application/json' -H "x-api-key: $API_KEY" \
  -d '{"ref":"cust-42","country":"NO","name":"Equinor ASA","regNumber":"923609016"}'
```

Fields: `country` (required, code from `/api/config`), `name` (required, 3+ chars), `regNumber`, `taxId`, `iec`, `exporter` (bool), `gln`, `address`, `city`, `region`, `postalCode`. Unknown fields are dropped; strings are trimmed and capped at 300 chars.

Response (trimmed):

```json
{
  "country": "NO",
  "checkedAt": "2026-11-10T17:00:00.000Z",
  "summary": {
    "status": "verified",
    "confidence": "high",
    "verifiedBy": ["gleif", "no-brreg"],
    "inactiveIn": [],
    "manualChecks": 5
  },
  "results": [
    { "id": "no-brreg", "name": "Norway Brønnøysund Register", "mode": "auto",
      "outcome": "verified", "verified": true, "idMatched": true,
      "match": { "legalName": "EQUINOR ASA", "ids": [{ "type": "ORG NR", "value": "923609016" }],
                 "status": "REGISTERED", "address": "...", "url": "..." } },
    { "id": "dnb-duns", "name": "D&B D-U-N-S lookup", "mode": "manual", "url": "...", "copy": ["name", "address"] }
  ]
}
```

- `summary.status`: `verified` | `inactive` | `unverified`.
- `summary.confidence`: `high` (2+ sources agree, or a given number matched), `medium` (one source, name only), `none`.
- Auto result `outcome`: `verified` | `inactive` | `not_found`; or the result carries `skipped` / `error` instead.

`GET /v1/checks?ref=cust-42` (requires `x-api-key`) returns the last 50 saved checks for that ref, newest first.

Errors: `400` invalid JSON / unsupported country / name too short, `401` missing or wrong key, `413` body over 100 KB.

`POST /api/verify` and `GET /api/config` are what the web form uses: no key, nothing saved. Put the server behind auth or remove the form before exposing it publicly.

## Scheduled rechecks

`recheck.mjs` re-verifies every saved `ref` (latest form per ref), stores the new result, and logs status changes. Exits `2` if any status changed, so a scheduler can alert.

```bash
node --env-file=.env recheck.mjs
```

Cron, daily 03:00:

```cron
0 3 * * * cd /path/to/verify && node --env-file=.env recheck.mjs >> data/recheck.log 2>&1
```

## Coverage

34 countries: US, CA, IN, BR, AE, SG, NO and all 27 EU states.

**Automatic** (free, no key):

| Source | Countries |
|---|---|
| GLEIF (LEI registry) | all |
| SEC EDGAR | US (needs `CONTACT_EMAIL`) |
| New York, Colorado, Connecticut, Oregon Secretaries of State | US |
| OrgBook BC | CA |
| EU VIES VAT validation | EU (needs VAT number) |
| INSEE Sirene / ARES / PRH-YTJ / RIK | FR / CZ / FI / EE |
| Singapore ACRA | SG |
| Brønnøysund Register | NO |
| Receita Federal via BrasilAPI | BR (needs CNPJ) |
| EUIPO EU trademarks, by owner name | all (needs EUIPO keys) |

**Trademarks are supporting evidence only.** Owning a trademark shows a brand, not a registered, active entity, so trademark results never make a check "verified" or "inactive". They appear as TRADEMARK OWNER cards and in `summary.trademarksIn`. USPTO and CIPO have no name-search API (USPTO's TSDR API looks up by serial number only; CIPO publishes bulk CSV), so they are manual links.

**Manual** (CAPTCHA or no API): Corporations Canada, Canada's Business Registries, ISED company capabilities, MCA name search and find-CIN, DGFT IEC (exporters), QuickCompany, Delaware, California bizfile, SAM.gov, USPTO trademark search, CIPO trademarks database, EU BRIS, Receita CNPJ card, UAE NER / FTA TRN / ADGM / DIFC / Dubai Chambers, KvK (NL), Registro Imprese (IT), WKO (AT), Singapore Bizfile, and globally ICC World Chambers, OpenCorporates, GS1 GEPIR, D&B D-U-N-S and directory.

## Adding a country or source

Everything is in `config.json`.

Add a country:

```json
"countries": {
  "XX": { "name": "Example Country", "idTypes": [{ "type": "REG", "label": "Company number" }] }
}
```

EU members also get `"region": "EU"` so EU-wide sources apply.

Add a **manual** source (no code). `{field}` in `url` is filled from the form, URL-encoded; `copy` lists fields that get Copy buttons:

```json
{ "id": "xx-registry", "name": "Example Registry", "countries": ["XX"], "mode": "manual",
  "url": "https://registry.example/search?q={name}", "copy": ["name", "regNumber"] }
```

`countries` takes country codes, a region (`"EU"`), or `"*"` for all. Optional `"when": "exporter"` shows a source only when that form flag is set.

Add an **automatic** source: add the config entry with `"mode": "auto"` (optional `"needs": "taxId"` or `"regNumber"`, `"needsEnv": ["SOME_KEY"]` to skip when a credential is unset, `"supporting": true` to show results without counting toward verification), then an adapter with the same id in the `auto` object in `server.mjs`. An adapter takes the form and returns candidate records:

```js
{ legalName, aliases?, ids: [{ type, value }], status, active?, address, url }
```

`judge()` handles matching: legal-suffix-insensitive names, number kinds (VAT/EIN/TRN vs registration), and active/inactive status. Set `active: true/false` when the registry states it; otherwise it is inferred from the `status` text.

## Tests

```bash
npm test
```

## Notes

- Only official or openly licensed registries are queried automatically. Sites with CAPTCHAs or terms forbidding automation stay manual; this app does not bypass CAPTCHAs.
- A registry match proves the entity exists in that register, not that whoever submitted the form represents it.
