# Ella Zwift

A local-first indoor route-riding prototype for a Wahoo KICKR. It imports GPX
routes, displays route progress and trainer metrics, can read your own Strava
activities, and can upload recorded rides to Strava.

The app is intentionally served from `localhost`: the browser needs a secure
context for Bluetooth, and the local Python service keeps Strava credentials
out of the web page. GPX files and recorded rides stay on this computer.

## Pick this up later

The project is intended to be cloned from the private GitHub repository onto
your Mac. Follow [Clone and run on macOS](#clone-and-run-on-macos) first.
Git only transfers committed and pushed changes. Credentials, keychain entries,
and locally recorded rides are not included in a clone.

**Current state**

- Strava subscription is active, but the Strava API application and local
  credentials have not been set up.
- Cloudflare Worker code is included, but it has not been deployed; the KV
  namespace ID in `cloudflare/wrangler.toml` is still a placeholder.
- The trainer is believed to be a KICKR v5, but its exact model and firmware
  are unconfirmed. First hardware target is Mac + Chrome.
- The app supports FTMS only. Do not enable resistance control if the trainer
  does not advertise FTMS.
- Garmin heart rate and Street View are intentionally not implemented.

**When ready, continue in this order**

1. **Identify the trainer.** Read the model from its label or Wahoo Fitness
   app, note its firmware version, and install any offered firmware update.
   Keep the model and firmware details handy; no account password or secret is
   needed for this step.
2. **Create the Strava API app.** Follow [Exact Strava setup](#exact-strava-setup):
   use `localhost` as the authorization callback domain, then save the Client
   ID and Client Secret only in the ignored local `strava.local.json`. Never
   paste either value into chat, email, or a public issue.
3. **Deploy the webhook.** Follow [Public Strava webhook](#public-strava-webhook-recommended)
   to create the Cloudflare KV namespace and deploy the Worker. Replace the KV
   placeholder in `cloudflare/wrangler.toml`; add the deployed Worker URL and
   the same `ADMIN_TOKEN` to `strava.local.json`. Restart the local app and
   click **Register webhook** after connecting Strava.
4. **Start locally.** Follow [Clone and run on macOS](#clone-and-run-on-macos).
   Connect Strava, verify the activity list loads, and verify the Strava panel
   says the deauthorization webhook is active.
5. **Test the trainer cautiously.** Use the [KICKR connection steps](#kickr-v5-connection-steps).
   Close Wahoo and other trainer apps first. Confirm the FTMS diagnostics
   before enabling control; keep the bike stable and begin at 0% grade with a
   short, easy route. Leave auto-upload off until you intentionally want a test
   activity uploaded.
6. **Check the result.** Confirm the ride was saved in local history, then
   upload a short test ride when ready. Verify the resulting activity on
   Strava. The app currently uploads TCX without heart rate.

When resuming with an assistant, open this project folder and say:

> Resume the Ella Zwift setup from README.md's "Pick this up later" section.
> My trainer is **[exact model]**, firmware **[version]**, and I am using
> **[Mac model/macOS version]** with Chrome. I have created the Strava API app
> and am ready to set up its local credentials and test the connection. Do not
> ask me to send credentials or tokens in chat.

## Requirements

- Python 3.10 or newer
- Google Chrome or Microsoft Edge with Bluetooth enabled
- A Bluetooth-capable computer and a powered-on KICKR
- Optional: a Strava API application for activity sync and upload

The trainer implementation uses the standard Bluetooth Fitness Machine Service
(FTMS). Wahoo's [KICKR v5 firmware release notes](https://support.wahoofitness.com/hc/en-us/articles/360016826680-KICKR-v5-2020-Firmware-Release-Notes)
list FTMS support in firmware 4.2.1 and 4.2.3; update to the latest firmware
offered in the Wahoo app. FTMS and actual resistance control have not yet been
tested on your trainer. If FTMS is unavailable, the app reports that instead
of attempting proprietary Wahoo or ANT+ commands.

## Clone and run on macOS

1. Install [Google Chrome](https://www.google.com/chrome/) and
   [Python 3](https://www.python.org/downloads/macos/) (3.10 or newer). Open
   **Terminal** and run `python3 --version` to confirm the version.
2. Ensure Git is available by running `git --version`. If macOS prompts to
   install Command Line Tools, accept the prompt and finish installation.
3. Sign in to GitHub on the Mac using an account that can access the private
   repository. One option is [GitHub CLI](https://cli.github.com/): install
   it, run `gh auth login`, select **GitHub.com**, choose **HTTPS**, agree to
   authenticate Git, and complete the browser sign-in. Do not paste tokens
   into chat.
4. Clone the repository and create an isolated Python environment:

   ```sh
   cd ~
   git clone https://github.com/willmsedo/ella_zwift.git
   cd ella_zwift
   python3 -m venv .venv
   source .venv/bin/activate
   python -m pip install -r requirements.txt
   python app.py
   ```

   If cloning fails with repository not found or an authentication error,
   verify that the signed-in GitHub account has access to this private repo.
   The clone contains the committed code only; it does not contain Strava
   credentials or rides recorded on another computer.
5. Open <http://localhost:8765> in Chrome and keep Terminal open. The app
   displays the route as a stylized line map, not a street-map basemap.
   Import a GPX file to preview it even before setting up Strava or a trainer.
   To stop the service, press **Control-C** in Terminal.
6. To start it again later, open Terminal and run:

   ```sh
   cd ~/ella_zwift
   source .venv/bin/activate
   python app.py
   ```

   To get later committed updates, stop the service and run `git pull` inside
   `~/ella_zwift`. If dependencies have changed, rerun
   `python -m pip install -r requirements.txt` with the environment activated.
   Do not overwrite local edits when updating.

## Run on Windows

```powershell
cd C:\Users\willm\ella_zwift
python -m pip install -r requirements.txt
python app.py
```

Open <http://localhost:8765> in Chrome. Keep the terminal open while using the
app. The Python service only listens on the local computer.

## Exact Strava setup

1. Sign in to the Strava account that will own the activities. Open
   <https://www.strava.com/settings/api> and create an API application. Fill in
   Strava's required app fields; the name and description can identify this as
   a personal local ride app. Strava currently requires a Strava subscription
   to create an API app; new apps start in single-player mode for the owner's
   account.
2. Set **Authorization Callback Domain** to exactly `localhost` (no
   `http://`, path, or port). The app's local redirect is
   `http://localhost:8765/oauth/callback`.
3. Copy the app's **Client ID** and **Client Secret** into a new file named
   `strava.local.json` in this repository:

   ```json
   {
     "client_id": "YOUR_CLIENT_ID",
     "client_secret": "YOUR_CLIENT_SECRET"
   }
   ```

   On the Mac, open a second Terminal window, run `cd ~/ella_zwift` and then
   `nano strava.local.json`. Enter the JSON with your own values, press
   **Control-O**, press **Return**, then press **Control-X** to save and exit.
   The file is local and ignored by Git.
4. Save the file, restart `python app.py` in the activated environment, and open <http://localhost:8765>.
   Click **Connect Strava**. Strava will show an authorization page for this
   app; approve the requested activity access. The browser should return to
   Ella Zwift with Strava connected.
5. Click **Refresh activities**. The app fetches 50 recent cycling activities
   at a time; use **Load older rides** to fetch more on demand. Rides with GPS
   route polylines are grouped when their distance is within 18% and their
   sampled route shapes are within about 150 m on average (including
   reverse-direction matches). Choose **Ride route** to use its elevation
   profile, or **Add ghost** to show that activity's recorded position at the
   same elapsed time in your current ride.
6. Leave **Upload finished rides to Strava when connected** checked to upload
   each finished ride automatically. The local service creates a TCX activity
   containing time, GPS position along the route, distance, altitude, speed,
   power, and cadence when available. It then polls Strava's asynchronous
   upload status. Heart rate is intentionally not collected or uploaded yet.

The app requests `activity:read_all` so it can list your private activities,
and `activity:write` so it can upload activities. Strava does not give the app
your password. The refresh token is kept in the operating system keychain;
the access token is held in memory. The client secret is in
`strava.local.json`, which is ignored by Git.
Never commit or share either. **Disconnect Strava** removes the saved token
from this computer. To revoke the app at Strava too, remove it from Strava's
connected-app settings.

### Public Strava webhook (recommended)

The local Python app cannot receive callbacks from Strava, so the repository
includes a small Cloudflare Worker in `cloudflare/worker.js`. Strava may send
activity event metadata to the Worker; it stores only the subscription ID and
an authorization-revoked flag in Cloudflare KV, not activity data or access
tokens. The local app checks this state
before Strava API calls. If the Worker is configured but unreachable, Strava
API calls fail closed; local GPX rides and history remain available. The
webhook is not active until you deploy and register the Worker.

1. Install Node.js (which includes npm) on the computer where you will deploy
   the Worker. From the repository directory, create a Cloudflare account if
   needed, then run:

   ```sh
   cd cloudflare
   npx wrangler@latest login
   npx wrangler@latest kv namespace create WEBHOOK_STATE
   ```

2. Copy the `id` returned by the KV command into `cloudflare/wrangler.toml`,
   replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
3. Generate two different random strings; keep the first as `VERIFY_TOKEN` and
   the second as `ADMIN_TOKEN`. For example, run
   `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` twice on Mac.
   Enter each value when prompted by these commands, along with the same
   Strava Client ID and Client Secret used in `strava.local.json`:

   ```sh
   npx wrangler@latest secret put STRAVA_CLIENT_ID
   npx wrangler@latest secret put STRAVA_CLIENT_SECRET
   npx wrangler@latest secret put VERIFY_TOKEN
   npx wrangler@latest secret put ADMIN_TOKEN
   npx wrangler@latest deploy
   ```

4. Note the deployed Worker URL printed by Wrangler, such as
   `https://ella-zwift-strava-webhook.<your-account>.workers.dev`. Add the URL
   and your `ADMIN_TOKEN` to the local `strava.local.json`:

   ```json
   {
     "client_id": "YOUR_CLIENT_ID",
     "client_secret": "YOUR_CLIENT_SECRET",
     "webhook_status_url": "https://YOUR-WORKER-URL",
     "webhook_admin_token": "THE_SAME_ADMIN_TOKEN"
   }
   ```

   Do not share or commit this file. Restart `python app.py`, connect Strava,
   then click **Register webhook** in the Strava panel. The app registers the
   Worker callback with Strava and displays whether it is active. The OAuth
   callback domain in Strava remains `localhost`; the Worker callback is
   registered separately by the button.
5. To verify the setup, reload the app and confirm the Strava panel says the
   deauthorization webhook is active. Disconnecting from the local app only
   removes the local token. Revoking the app in Strava's connected-app
   settings sends the webhook event, after which the local app clears its
   stored token when it next checks webhook state.

If you do not deploy the Worker, local Strava reads and uploads can still be
tested, but webhook deauthorization monitoring is inactive. See Strava's
<https://developers.strava.com/docs/webhooks/> and
<https://developers.strava.com/docs/getting-started/> guides.

## KICKR v5 connection steps

1. **Confirm the trainer.** Check the label on the trainer or the Wahoo app to
   verify it is the 2020 KICKR v5, model WFBKTR120. Wahoo's v5 support page is
   [here](https://support.wahoofitness.com/hc/en-us/articles/29235861059986-KICKR-v5-2020-Smart-Trainer-Information-FAQ).
   If the model differs, note the model and firmware before proceeding; do not
   assume the v5 firmware notes apply.
2. **Prepare it.** Put the trainer on a stable floor, plug in its power
   adapter, install the bike using the correct hub adapters, and make sure the
   bike is secure before mounting. With a KICKR CLIMB attached, grade commands
   may also move the front of the bike; ensure it has room to move.
3. **Check firmware.** If the trainer has not been used recently, open the
   Wahoo Fitness app on an iOS/Android phone, connect to the KICKR, and install
   any offered firmware update. Wahoo's firmware instructions are
   [here](https://support.wahoofitness.com/hc/en-us/articles/13354735432850-How-to-Update-Firmware-on-KICKR-trainers-BIKEs-and-RUN).
   Firmware updates/setup are performed through that app, not this web app.
4. **Free the connection.** Disconnect the KICKR in the Wahoo app and fully
   close that app. Also close Zwift, SYSTM, TrainerRoad, and any other app that
   may be connected. Only one app should be issuing resistance commands.
5. **Start Ella Zwift.** Run the local Python service, open
   <http://localhost:8765> in desktop Chrome, and enable Bluetooth in the
   computer's system settings. Allow Chrome Bluetooth access in macOS Privacy
   & Security settings if prompted. In the app, click **Connect KICKR**, select
   the KICKR in Chrome's Bluetooth chooser, and approve the connection. Do not
   pair it separately in macOS Bluetooth settings first.
6. **Check before control.** The app reads FTMS indoor-bike data, the FTMS
   control point, trainer feature bytes, and supported incline range. It sends
   no resistance command merely by connecting. Control stays disabled if the
   trainer reports an incline range that does not include 0%.
7. **Enable and start gently.** With the bike stationary and the rider ready,
   click **Enable control**. The app requests control, sends start/resume, then
   requests 0% grade. Import a short, easy GPX and click **Start ride**. The
   initial app range is -5% to +8%, updates ramp by no more than 1 percentage
   point per second, and unsupported trainer incline values are clamped.
8. **Pause or finish.** **Pause** requests neutral grade while keeping the
   recording. **Finish** requests neutral grade, saves the ride locally, and
   uploads it if Strava is connected and auto-upload is enabled. If Bluetooth
   drops, stop pedaling; the app marks the ride paused and shows a warning.
   Trainer behavior during a disconnect is model/firmware-specific.

The app's trainer implementation requires the standard Bluetooth FTMS
service. Actual advertised services depend on the trainer and firmware. Wahoo
currently notes that some Windows trainer-control setups require an ANT+ USB
adapter, while Mac computers with built-in Bluetooth are listed as supported
([device compatibility](https://support.wahoofitness.com/hc/en-us/articles/4409281095058-Device-Compatibility-for-Wahoo-smart-trainers-KICKR)).
This prototype does not yet implement ANT+ FE-C or Wahoo's proprietary BLE
commands. If Chrome reports that FTMS is missing, do not enable control; first
try the updated trainer on the Mac/Chrome setup, then we can add a native
Bluetooth/ANT+ bridge based on the actual diagnostics.

## Current scope

- GPX import and elevation/route preview
- FTMS trainer connection diagnostics and guarded grade control
- Live trainer metrics and local ride recording
- Strava activity list, route grouping, selected-ride ghosts, and TCX upload
- Heart-rate fields are reserved for later; Garmin integration is not active
- No Street View, accounts, remote hosting, or cloud storage

Strava uploads are asynchronous. The app waits for Strava's processing result
and displays the resulting activity ID when available.

## Checks

```powershell
python -m unittest discover -s tests -v
python -m py_compile app.py
```
