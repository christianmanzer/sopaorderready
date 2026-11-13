# Order board

A live "Preparing / Ready for pickup" screen for a restaurant TV. Toast sends a
webhook the moment an order changes, a Cloudflare Worker updates the board, and
every open screen updates within a fraction of a second.

```
Toast POS  --webhook-->  Worker (checks signature)  -->  Board object (keeps the orders)
                                                              |
                                              live push (WebSocket, polling as backup)
                                                              |
                                                        TV browser: /sopa/orderready
```

Read-only. The board never writes anything back to Toast.

## How the board decides

Toast tracks a status on every item in an order (`fulfillmentStatus`):

| Item status | Meaning | Board |
|---|---|---|
| NEW | On the check, not sent to the kitchen | Not shown |
| HOLD | Paused by staff | Ignored |
| SENT | Fired, showing on the KDS | Preparing |
| READY | Marked ready on the KDS | Ready for pickup, once nothing is still SENT |

Also: voided orders disappear, dine-in table orders are skipped, a ready number
stays up for 30 minutes, and an order nobody ever marks ready drops off after 60
minutes. Both limits are in `wrangler.toml`.

An order where some items are READY and the rest never leave SENT (typically an
item that does not go through the KDS) moves to Ready after 3 minutes.

**Not visible to the board:** pressing **Order Ready** by hand in Toast's Orders
Hub moves an order to Ready on Toast's own board, but Toast does not send that
as an order change, so this board cannot see it. Bump tickets on the KDS instead
(see below). Orders nobody bumps drop off after the 60 minute limit.

**Important:** Toast only sets READY when the restaurant uses the Toast kitchen
display (KDS) and staff bump orders on it. If tickets are never bumped, orders
stay in Preparing. Step 5 below checks this before you rely on the board.

## Setup

### 1. Deploy

Push this folder to a GitHub repo, then in Cloudflare go to Workers & Pages,
Create, Import a repository. Or from this folder: `npm install` then
`npx wrangler deploy`. You get a URL like `https://sopaorderready.<you>.workers.dev`.
To use your own address (for example `board.fivem.group`), add a custom domain
to the Worker in its Settings.

### 2. Add the admin key

Secrets reach the Worker through `secrets.env` in this folder, which holds
names only (never real values). The real value lives in Cloudflare:

1. Worker, Settings, **Builds**, **Variables and secrets**, Add: type **Secret**,
   name `ADMIN_KEY`, value any long random string. It protects the setup log in
   step 4.
2. Worker, Settings, **Builds**, **Deploy command**: change it to
   `npx wrangler deploy --secrets-file secrets.env`.
3. Push any change to GitHub (or retry the latest build). Each deploy then
   uploads the secrets named in `secrets.env` to the running Worker.

(If your dashboard offers Settings, Variables and Secrets for the running
Worker, adding the secret there works too.)

### 3. Create the Toast webhook

In Toast Web: Integrations, Toast API access, Manage webhooks. Create a
subscription for the **orders** event category and set the endpoint to
`https://YOUR-WORKER-URL/webhook/toast`. Toast shows a secret key for the
subscription. Add it the same way as `ADMIN_KEY` in step 2: a build secret named
`TOAST_WEBHOOK_SECRET`, plus a new line `TOAST_WEBHOOK_SECRET=$TOAST_WEBHOOK_SECRET`
in `secrets.env`. Only add that line once the build secret exists.
(Several subscriptions? Use `TOAST_WEBHOOK_SECRETS` with the secrets separated
by commas.)

### 4. Find the restaurant GUID

Send one test order to the kitchen. Then open
`https://YOUR-WORKER-URL/admin/recent?key=YOUR_ADMIN_KEY`. The newest entry says
`no board for this restaurant GUID` and shows the GUID in `restaurant`. Paste it
into `wrangler.toml` under `[vars.LOCATIONS.sopa]` as `restaurantGuid`, commit,
and let it redeploy.

If the entry says `rejected: bad signature` instead, see Troubleshooting.

### 5. Verify with a real order

Place a real takeout order, send it, then bump it on the KDS. Refresh the
`/admin/recent` page. You should see the same order twice: first with
`"SENT"` in `statuses` and `action: show: preparing`, then `"READY"` and
`action: show: ready`. If READY never appears, the location is not marking items
ready in Toast and the board cannot show ready orders. Fix that first.

Check `nameFound` too: it should say `"tab"` on orders where staff typed a name
(see Names). Look at `diningOption`, `tableOrder` and `source` on your real
orders as well. If
dine-in orders or delivery orders show up that should not be on the board, copy
the Takeout dining option GUID into `diningOptionGuids` for the board:

```toml
[vars.LOCATIONS.sopa]
name = "SOPA!"
restaurantGuid = "..."
diningOptionGuids = ["takeout-guid-here"]
```

### 6. Put it on the TV

Open `https://YOUR-WORKER-URL/sopa/orderready` in the TV browser and set it as the home
page. Turn off the TV and device screensaver and sleep timers. The page
reconnects by itself, reloads itself every night at 3 AM, and reloads when you
change `APP_VERSION` in `wrangler.toml` and redeploy (so you can push changes to
every screen without touching them).

## Preview and testing

- **See the design right now, no setup:** open `public/board.html?demo=1` in any
  browser. Add `&names=1` to see name labels and `&est=1` to see estimated times.
- **Run it locally:** `npm install`, copy `.dev.vars.example` to `.dev.vars`,
  `npm run dev`, then open `http://localhost:8787/sopa/orderready`.
- **Send fake orders:** `npm run simulate -- --status preparing --number 42`.
  Statuses: `preparing`, `ready`, `mixed`, `unfired`, `voided`, `dine-in`. Use
  `--order <id>` with the same id to move one order from preparing to ready.
- **Unit tests:** `npm test`.
- **Check a screen's connection:** open the board in a desktop browser and run
  `__boardStatus()` in the console.

## Options (`wrangler.toml`)

| Setting | What it does |
|---|---|
| `READY_MINUTES` | How long a ready number stays up (30) |
| `PREP_MINUTES` | When a never-bumped order drops off (60) |
| `MIXED_READY_MINUTES` | An order with some items READY and the rest stuck at SENT (for example a drink that never goes through the KDS) shows as ready after this long. SOPA uses 0 (right away) because the kitchen bumps whole tickets only; use 1 to 3 if partial bumps ever happen |
| `APP_VERSION` | Change it and redeploy to reload every open board |
| `diningOptionGuids` | Only show these dining options |
| `includeTableOrders` | `true` shows dine-in table orders |
| `showNames` | `true` shows each guest's first name under the number (on for SOPA). See Names |
| `showEstimate` | `true` shows Toast's estimated ready time on Preparing tiles ("Est. 12:25") when the order has one (on for SOPA). See Estimated time |
| `timezone` | Time zone for the "Updated" time (default `America/Denver`) |
| `theme` | Colors. Defaults are the SOPA! brand colors (cream `#faf6ee`, green `#80af60`, pink `#e87a96`). Override with, for example, `theme = { ready = "#80af60", background = "#faf6ee" }`. Keys: `background`, `ready`, `readyInk`, `preparing`, `muted`, `accent` (the offline notice), `readyChip`, `readyChipInk`, `preparingChip`, `preparingChipInk` (the order tiles and their text) |

A second board for another location is another `[vars.LOCATIONS.<name>]` block
with its own `restaurantGuid` and colors (`[vars.LOCATIONS.<name>.theme]`). Its screen is `/<name>/orderready`, for example `boards.primeraagua.com/gardunos/orderready`. One Toast webhook subscription can feed every location: the Worker sends each order to the board whose `restaurantGuid` matches. `/b/<name>` also works as a short form.

To serve the boards at your own address, add `boards.primeraagua.com` as a custom domain on the Worker (the domain must be on Cloudflare), or uncomment the `routes` line near the top of `wrangler.toml`.

## Names

With `showNames = true` the board shows each guest's first name under the
number. Where the name comes from on a Toast order:

1. **Customer first name**, if Toast includes it. Toast only sends it when the
   API client has the `guest.pi:read` scope, which also exposes guest personal
   information. This project does not ask for that scope.
2. **Tab name on the check** (what staff type at the counter). No extra scope
   needed. This is what the board uses today.

Names are cleaned before display: first name only, ALL CAPS and lowercase become
"Maria", at most 14 characters. Anything containing a digit is skipped, so
delivery-app IDs and phone numbers never show. An order with no usable name just
shows its number.

**Check it with a real order (step 5):** in `/admin/recent`, `nameFound` says
`"tab"` when a name was found on the check and `null` when not. If it is `null`
on orders where staff did type a name, the name is stored somewhere else in your
Toast setup (for example only on the customer record). Tell me what you see and
we will decide whether the extra scope is worth it. Set `showNames = false` to
turn names off.

## Estimated time

With `showEstimate = true`, Preparing tiles show "Est. 12:25" when Toast gives
the order an expected ready time. The board reads `estimatedFulfillmentDate`
from the order, which Toast calculates from when the order opened plus the
location's prep time, and falls back to `promisedDate` (the scheduled time on
future orders). Anything more than 12 hours away is ignored. An order with no
estimate just shows its number and name.

**Check it with a real order:** in `/admin/recent`, `etaFound` says `"estimated"`,
`"promised"` or `null`. If it is `null` on real orders, Toast is not sending an
estimate for them. The prep time comes from the takeout prep time in Toast's
restaurant settings, so changing it there changes what the board shows.

## Font

The board uses Source Serif 4 (a Times-style serif, SIL Open Font License). The
two font files are in `public/fonts/` and are served by the Worker itself, so
every screen shows the same type with no outside requests. If they fail to load,
the screen falls back to Georgia, then Times New Roman. To change the font,
replace the two files, update the `@font-face` lines and the `font-family` in
`public/board.html`.

## Tile size

Tiles are capped at half the panel width and about 40% of its height, so one or
two orders stay a normal size instead of filling the panel. They fill from the
top left, and the numbers grow as orders are added until the panel is full.

## Vertical (portrait) screens

Nothing to set. When a screen is taller than it is wide, the board stacks the
panels: Ready on top, Preparing underneath, footer at the bottom. Wide screens
look exactly as before. Square screens use the stacked layout. All sizes scale
from the screen width on tall screens and from the height on wide ones, so a
vertical TV looks like a horizontal one turned on its side. Tested from 720x1280
to 1080x1920 and a 768x1024 tablet, including a full rush of 24 ready and 20
preparing orders.

## Logo

A board can show a logo at the bottom instead of the name as text. Put the
picture in `public/logos/` (a transparent PNG, about 1200 px wide, or an SVG) and
add one line to the location in `wrangler.toml`:

    logo = "/logos/sopa.png"

The logo only replaces the name once it has loaded. If the file is missing or
fails to load, the name shows as text, so the footer is never empty. SOPA!'s
logo is `public/logos/sopa.png` (trimmed from the original, same brand green and
pink as the board).

## Reliability and security

- **Signatures:** every webhook is checked against Toast's `Toast-Signature`
  header. Anything that fails is rejected and logged. `SIGNATURE_MODE = "log-only"`
  exists only for first-day troubleshooting. Set it back to `"enforce"`.
- **Retries and duplicates:** Toast retries failed deliveries after 5 and 10
  minutes. Duplicate events are ignored, and a late retry carrying older state
  cannot move an order backwards.
- **Late edits:** tip adjustments and refunds that touch an order hours later do
  not bring a finished order back onto the board.
- **"Updated" time:** the small `Updated 10:42 AM` at the bottom right is the last
  time that screen heard from the server (a health check about every 15 seconds,
  or an order change). It uses server time, so a wrong TV clock does not matter.
  If it stops moving, the screen is frozen or offline. It is replaced by the
  "Not live" notice after 45 seconds without contact.
- **Connection loss:** the screen retries with backoff and falls back to
  polling. After 45 seconds with no contact it shows "Not live. Please ask at the
  counter." and clears itself when the connection returns.
- **Privacy:** names are first names only, taken from what staff typed on the
  check (see Names). No guest personal information is requested from Toast, and
  the setup log records where a name came from but never the name itself.
- **Cost:** the board uses hibernating WebSockets, so an idle board costs
  almost nothing.

## Troubleshooting

| What you see | What to check |
|---|---|
| `/admin/recent` is empty | Toast is not reaching the Worker. Check the endpoint URL and that the subscription is active. |
| `rejected: no secret set` | Add `TOAST_WEBHOOK_SECRET` (step 3). |
| `rejected: bad signature` | The secret is for a different subscription or environment, or Toast's signing details differ from the docs. Set `SIGNATURE_MODE` to `log-only`, send one order, and read `sigOk` in the log. If it is still false with the right secret, the signature input needs adjusting in `src/signature.js`. |
| Orders appear but never move to Ready | Items are not reaching READY in Toast (see step 5). |
| Wrong orders appear | Use `diningOptionGuids` (step 5). |
| Two screens show the same number | Toast's order numbers restart daily and are not guaranteed unique. Rare inside a 30 minute window. |
| "Not live" on the TV | The TV lost internet or the Worker is down. The board recovers on its own. |

## Backup check against Toast (optional)

If an order's last webhook never arrives, the board would show it as Preparing
until the 60 minute limit. With the Toast API credentials set, the board asks
Toast directly about any order that has been Preparing for a couple of minutes
(about once a minute per order, a handful of read-only calls) and updates it if
Toast's data says otherwise. It is off until both secrets exist.

1. Toast Web, Integrations, Toast API access, Manage credentials, open the
   "SOPA Order Board" credentials. Copy the **Client ID** and **Client secret**.
2. Cloudflare, Worker, Settings, Builds, Variables and secrets: add two
   **Secrets**, `TOAST_CLIENT_ID` and `TOAST_CLIENT_SECRET`.
3. Only after both exist, add these two lines to `secrets.env` and push:
   `TOAST_CLIENT_ID=$TOAST_CLIENT_ID` and `TOAST_CLIENT_SECRET=$TOAST_CLIENT_SECRET`
4. In `/admin/recent`, a corrected order shows as `poll: preparing -> ready`.
   A problem shows as `poll error: ...` (at most once every 10 minutes).

It reads only. If Toast's own data still says SENT, the check changes nothing;
the log is how you find out.

## Not included yet
- Sound when an order turns ready (browsers need a tap before they allow audio).
