# Ella Zwift

A local-first indoor route-riding prototype for a Wahoo KICKR. It imports GPX
routes, displays route progress and trainer metrics, can read your own Strava
activities, and can upload recorded rides to Strava.

The app is intentionally served from `localhost`: the browser needs a secure
context for Bluetooth, and the local Python service keeps Strava credentials
out of the web page. GPX files and recorded rides stay on this computer.

## instructions for Ella

This is a from-scratch guide for a MacBook, Chrome, and a Wahoo KICKR. You do
**not** need Copilot. Follow the numbered sections in order; click the
**Troubleshooting** line under each section if you get stuck. If you are reading
this on GitHub, click **Code** near the top of the repository page to view this
README.

**Important:** This is a prototype. Its KICKR control, Mac setup, Strava
connection, upload, and public webhook have **not** yet been tested together on
your hardware and accounts. These instructions describe the intended setup,
not a guarantee that every integration will work. Do not ride if the bike or
trainer is unstable or resistance behaves unexpectedly.

### 1. Gather what you need

- Your MacBook, its charger, internet access, and permission to install apps.
- A GitHub account with access to the private
  `willmsedo/ella_zwift` repository. The owner must invite your GitHub account
  as a collaborator, and you must accept the invitation. You do not need the
  owner's GitHub password. See
  [GitHub's collaborator instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository).
- A powered KICKR, securely installed bike, and an iPhone or Android phone
  for the Wahoo app and firmware updates. The trainer is believed to be a
  **KICKR v5 (2020)**, but check its label or Wahoo app first.
- A GPX file of an outdoor route, or a Strava account with a GPS activity
  to export. GPX is enough to try local riding; Strava and Cloudflare setup
  can be done later.
- For direct Strava activity access and automatic upload: the Strava account
  whose rides you want to use, a Strava subscription if required by Strava,
  and permission to create an API app on that account. New Strava API apps
  begin in **single-player mode**: only the app owner's Strava account can
  authorize it. If Ella wants her own Strava account, she should create her
  own API app rather than use someone else's single-player app or secrets.
- For the public deauthorization webhook: a Cloudflare account and Node.js.
  The GPX-only app does not need them. Hosting can have limits or costs; check
  Cloudflare's current plan and pricing before deploying.

The route display is a stylized line map, **not** a street-map or Street View.
The app does not collect Garmin heart rate. Its weight box does not currently
change resistance or speed calculations.

<details>
<summary>Troubleshooting: I cannot see the repository or do not have an account</summary>

Create your own free account at <https://github.com/>. Ask the repository owner
to invite that account, then accept the invitation using GitHub or the invitation
email. Sign in at <https://github.com/willmsedo/ella_zwift> to confirm that the
repository opens. A “404” can mean you are signed into the wrong account or have
not accepted the invitation; it does not necessarily mean the repository is gone.
Do not make the repository public to work around access.

</details>

### 2. Check macOS and install Chrome

1. Click the **Apple menu** in the top-left corner, then **About This Mac**.
   Note the macOS version and whether the chip is Apple silicon or Intel.
2. Current Chrome requires **macOS 13 Ventura or newer**; current Wrangler for
   the optional Cloudflare step requires **macOS 13.5 or newer**. Vendor
   requirements can change; see [Chrome's requirements](https://support.google.com/chrome/answer/95346)
   and [Wrangler's requirements](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
   Update macOS through **System Settings > General > Software Update** if
   your Mac supports it. Do not assume an old browser is safe or compatible.
3. If Chrome is not installed, open Safari, go to
   <https://www.google.com/chrome/>, and download Chrome for your Mac.
   Open the downloaded file and drag **Google Chrome** into **Applications**
   if prompted. Open Chrome from Applications and accept macOS's open prompt.
4. In Chrome, open **Chrome > About Google Chrome** and allow updates to finish.
   Relaunch if asked. Use **desktop Chrome**, not Safari or an iPhone browser,
   for the trainer connection.

<details>
<summary>Troubleshooting: Chrome or macOS will not install or update</summary>

Check the version in **About This Mac** against the linked requirements. If
the Mac cannot update to a supported version, use a supported computer rather
than bypassing macOS security or relying on an outdated browser. On a
managed/work Mac, an administrator may need to approve installation. If the
downloaded app is still in a disk image, drag it to Applications before
opening it.

</details>

### 3. Open Terminal and check Python

Terminal is a built-in app where you type commands. Press **Command-Space**,
type `Terminal`, and press **Return**. Click its window, paste one command at a
time, and press **Return**. Do not type the `$` or `%` prompt that Terminal
shows. Wait for a new prompt before entering the next command. If a command
fails, stop and use that section's troubleshooting instead of continuing.

1. Type this and press Return:

   ```sh
   python3 --version
   ```

2. The app requires Python **3.10 or newer**. For example, `Python 3.9.6`
   is too old; `Python 3.10.6` and `Python 3.13.0` meet the minimum. Python
   version numbers are separate numbers: **3.9 is older than 3.10**.
3. If Python is missing or too old, visit
   <https://www.python.org/downloads/macos/> in Chrome. Download a current
   **stable** Python 3 macOS installer compatible with your macOS; a
   **universal2** installer supports both Apple silicon and Intel. Open the
   downloaded `.pkg`, follow the installer, and enter the Mac administrator
   password only in the macOS installer prompt. Do not remove Apple's
   system Python. If the Python installer opens a folder containing
   **Install Certificates.command**, double-click it and wait for it to
   complete, as directed by the installer.
4. Quit and reopen Terminal. Run `python3 --version` again. Confirm it reports
   at least 3.10 before continuing. The app has been tested here with Python
   3.10 on Windows, not with every Python/macOS combination.

<details>
<summary>Troubleshooting: Python is missing, old, or the wrong version still appears</summary>

If macOS asks to install developer tools, allow the installation to finish and
check the version again. If it is still too old, install Python from
python.org as above and reopen Terminal. Run `which -a python3` to see which
installations are being found. A Python.org installer usually installs a
versioned command such as `python3.14`; run the matching command with
`--version`. In section 5, use that same versioned command in place of
`python3` when creating the virtual environment. For example, if
`python3.14 --version` works, use `python3.14 -m venv .venv`. Keep the `.venv`
activation and `python` commands unchanged. Choose the version actually
installed, not necessarily 3.14. If the Python installer is incompatible with
your macOS, check its download page for supported versions and update macOS
or use a supported computer. Do not delete the Apple-provided Python.

</details>

### 4. Install GitHub Desktop and copy the project to the Mac

GitHub Desktop is an app that downloads the private project; it is separate
from Copilot. This avoids installing Homebrew or using Git commands.

1. In Chrome, visit <https://desktop.github.com/> and download GitHub Desktop
   for macOS. Open the downloaded `.zip` in Finder's **Downloads**, then open
   **GitHub Desktop**. Move it to Applications if prompted.
2. Sign in to **GitHub.com** with the GitHub account that accepted the
   repository invitation. Follow the browser prompts and return to Desktop.
3. In Terminal, run `echo "$HOME/ella_zwift"` and note the complete path it
   prints, such as `/Users/ella/ella_zwift`. Yours may be different.
4. In GitHub Desktop, choose **File > Clone Repository**, then the **URL** tab.
   Enter `https://github.com/willmsedo/ella_zwift.git` as the repository URL.
   Set **Local Path** to the exact path printed in step 3. Click **Clone**.
   Wait until it finishes. You should now have an `ella_zwift` folder in your
   Mac user home folder.

<details>
<summary>Troubleshooting: GitHub Desktop or cloning fails</summary>

- GitHub Desktop currently requires macOS 12 or later; Chrome requires a newer
  macOS version. Check the version and update if supported. See
  [GitHub Desktop installation](https://docs.github.com/desktop/installing-and-authenticating-to-github-desktop/installing-github-desktop?platform=mac).
- If the private repository is not found, verify the invitation is accepted
  and Desktop is signed into the same GitHub account as your browser. Use
  **GitHub Desktop > Settings > Accounts** to check.
- If the destination already exists, do not delete or overwrite it. If it is
  already this repository, open it in Desktop with **File > Add Local
  Repository**. Otherwise choose a different path, and use that path instead
  of `~/ella_zwift` in the later commands.
- A clone contains committed files, not another computer's local rides,
  keychain tokens, or ignored `strava.local.json`.

</details>

### 5. Install the app and open it

1. In Terminal, enter each line separately, pressing Return after each:

   ```sh
   cd ~/ella_zwift
   python3 -m venv .venv
   source .venv/bin/activate
   python -m pip install -r requirements.txt
   python app.py
   ```

   If section 3 required a versioned Python command, replace only the
   `python3` in the second line with that command. The first line opens the
   project folder; the second makes an isolated Python environment; the third
   activates it; the fourth installs the app's dependency. Internet access is
   needed for installation.
2. Leave this Terminal window open. The last command should say the app is
   running at `http://localhost:8765`. It will not return to a prompt until
   you stop it.
3. In **Chrome**, type `http://localhost:8765` into the address bar and press
   Return. You should see **Ride your own roads** and a **Connect KICKR**
   button. This address refers to your own Mac; it is not a public website.
4. To stop the app later, click Terminal and press **Control-C**. This stops
   the local service; don't close it during a ride.

<details>
<summary>Troubleshooting: installation fails or the app page does not open</summary>

- `No such file or directory` after `cd`: the clone is not in the expected
  folder. In GitHub Desktop choose **Repository > Show in Finder**. In
  Terminal type `cd ` (including the space), drag the folder from Finder into
  Terminal, and press Return. Continue from `python3 -m venv .venv`.
- `python3` not found or Python older than 3.10: return to section 3.
- If activation worked, the prompt normally begins with `(.venv)`. If `python`
  or `pip` is not found, run `source .venv/bin/activate` from the project
  folder, then repeat the install command. If `.venv` was created with an old
  Python, ask someone experienced to help create a new environment; do not
  delete an unfamiliar folder.
- A pip network or certificate error can mean no internet, a proxy, or missing
  Python certificates. Check internet access and run Python.org's
  **Install Certificates.command** if supplied with that installation.
- `Address already in use` means another service may be using port 8765. Do
  not kill unknown processes. Stop an earlier Ella Zwift Terminal window with
  Control-C, or ask for help identifying the other service.
- If Chrome says it cannot connect, check that `python app.py` is still
  running in Terminal, and type the address exactly. If Terminal shows an
  error, read it before restarting.

</details>

### 6. Get and preview a route

1. If you have a GPX file, find it in **Finder > Downloads** or another folder.
   To export one from Strava, sign in at <https://www.strava.com/> in Chrome,
   open one of your **outdoor activities with GPS**, choose the **three-dot
   menu**, then **Export GPX**. Find the downloaded `.gpx` in Downloads.
   See [Strava's export guide](https://support.strava.com/en-us/articles/15401919-how-do-i-export-my-strava-data).
2. In the local app, click **Import GPX**, choose that `.gpx` file, and click
   **Open**. A route line, distance, and elevation profile should appear.
   The route must have at least two valid location points; elevation data is
   needed for hills. Without elevation, the app uses flat grade.
3. To practice without Strava, you can make a short **fictional** GPX file:
   open a second Terminal window, run `nano ~/Downloads/ella-test.gpx`, paste
   the following text, press **Control-O**, press **Return**, then press
   **Control-X**. Import `ella-test.gpx` from Downloads.

   ```xml
   <gpx version="1.1" creator="Ella test" xmlns="http://www.topografix.com/GPX/1/1">
     <trk><name>Flat test route</name><trkseg>
       <trkpt lat="47.0000" lon="-122.0000"><ele>10</ele></trkpt>
       <trkpt lat="47.0010" lon="-122.0000"><ele>10</ele></trkpt>
       <trkpt lat="47.0020" lon="-122.0000"><ele>10</ele></trkpt>
     </trkseg></trk>
   </gpx>
   ```

   This is a flat, roughly 220-metre synthetic route, not a real ride. Keep
   auto-upload **off** while using it; its made-up GPS points would otherwise
   appear in the uploaded activity.

<details>
<summary>Troubleshooting: GPX is missing, empty, or shows no hills</summary>

Select **Export GPX**, not **Export Original**: original downloads can be FIT
files, which this app cannot import. A GPS-less indoor activity cannot provide
an outdoor route. The app accepts `.gpx` files up to 10 MB. If the route lacks
elevation, use another GPX with elevation; the app cannot invent it. When
using `nano`, the key is **Control**, not Command; after Control-O confirm the
filename with Return. If Strava's menu has changed, use its linked export guide.

</details>

### 7. Prepare and connect the KICKR

1. Check the model on the trainer label or in the Wahoo phone app. The 2020
   KICKR v5 is model **WFBKTR120**. If it is another model, do not assume the
   v5 firmware guidance applies. See [Wahoo's v5 information](https://support.wahoofitness.com/hc/en-us/articles/29235861059986-KICKR-v5-2020-Smart-Trainer-Information-FAQ).
2. On a stable, level floor, open and lock the trainer legs, mount the bike
   using the correct adapters, and make sure everything is secure. Plug in
   the correct trainer power adapter. Follow
   [Wahoo's setup guide](https://support.wahoofitness.com/hc/en-us/articles/29240095043602-Set-up-your-KICKR-Smart-Trainer)
   if unsure. If a KICKR CLIMB is attached, allow room for the front of the
   bike to move when grade changes.
3. Install/open the **Wahoo** phone app, turn on phone Bluetooth, and follow
   its sensor setup to connect the trainer and check its firmware. Install
   updates offered for your exact trainer. Wahoo's
   [v5 release notes](https://support.wahoofitness.com/hc/en-us/articles/360016826680-KICKR-v5-2020-Firmware-Release-Notes)
   list Bluetooth FTMS support in firmware 4.2.1 and 4.2.3. Updating does not
   guarantee this prototype will work with your trainer.
4. Disconnect the trainer in Wahoo, fully close the phone app, and close Zwift,
   TrainerRoad, and other apps that might control it. On the Mac, turn
   Bluetooth on in **System Settings > Bluetooth**. If macOS asks for
   Bluetooth access for Chrome, allow it in **Privacy & Security > Bluetooth**.
   Connect using Chrome's chooser rather than pairing it separately first.
5. With the local app open in Chrome and the trainer powered, click
   **Connect KICKR**. Select the KICKR in Chrome's Bluetooth chooser, then
   click **Pair/Connect**. The app should show **Connected** and FTMS
   diagnostics. Connecting is read-only: it does not itself send a resistance
   command. Pedal gently and check whether speed, power, and cadence update;
   what is reported depends on the trainer.
6. Confirm the diagnostics show **Indoor Bike Data** and a **Control Point**.
   If FTMS is missing or the control button stays disabled, stop here; do not
   try to force control. This app does not implement ANT+ or proprietary Wahoo
   control. Actual compatibility with this trainer has not been verified.

<details>
<summary>Troubleshooting: the KICKR is not found, data is missing, or control is disabled</summary>

- Confirm trainer power, Mac Bluetooth, and Chrome permissions. Move the Mac
  near the trainer and retry **Connect KICKR**; select the trainer in Chrome,
  not another Bluetooth device.
- Close other trainer-control apps on every nearby device; disconnect Wahoo
  after updating firmware. KICKR v5 can have multiple Bluetooth connections,
  but another app may still hold control.
- If Chrome says Web Bluetooth is unavailable, ensure you are in current
  desktop Chrome at `http://localhost:8765`, not Safari, a file opened
  directly, or a remote HTTP address.
- If FTMS is missing, confirm the exact model and firmware in Wahoo, install
  any offered update, and reconnect. Record the displayed diagnostics and
  model/firmware for later help. Do not send passwords, tokens, or serial
  numbers. A Control Point can exist without supporting every command.
- If connected but no data changes while pedaling, stop riding and note the
  diagnostics. If control is refused, another app may hold it or this
  trainer/firmware may not support the command. Do not assume resistance is
  safe or that the prototype supports an untested device.

</details>

### 8. Record a short local test ride

1. Import an easy route with elevation or the flat test route from section 6.
   **Uncheck** “Upload finished rides to Strava when connected” for this first
   test. The box is checked by default unless you changed it previously.
2. Once the trainer is connected and the bike is secure, click **Enable
   control**. The app requests control, start/resume, then 0% grade. Check
   for the **Control enabled** message. Stop if anything feels unexpected.
3. Click **Start ride** and pedal gently. Watch speed, power, cadence, elapsed
   time, and your marker on the route. The app limits commanded grades to
   -5% through +8% and ramps normal changes; the actual response has not been
   verified on this trainer. Reported speed comes from the trainer, not a
   weight-based simulation.
4. Click **Pause** to pause or **Resume** to continue. Pause requests neutral
   grade; the trainer may react differently, particularly if disconnected.
   Keep Chrome and Terminal open and the Mac awake throughout.
5. After a short test, click **Finish**. The app requests neutral grade, saves
   the ride locally, and lists it under **Recent rides**. Click **Disconnect**
   in the KICKR panel after finishing. If Bluetooth disconnects, stop pedaling
   and inspect the trainer; the app pauses the ride.

<details>
<summary>Troubleshooting: Start is disabled, resistance is unexpected, or a ride is not saved</summary>

Start requires a loaded route and successfully enabled trainer control. If
control is rejected or resistance behaves unexpectedly, stop pedaling and
do not continue until the trainer is safe. Confirm no other app is controlling
it. If the local save fails, read the ride message and verify Terminal is
still running and the Mac has free space. A ride is held in the browser until
finished; closing the page or stopping the app during a ride can lose it.
Route progress stops at the route end, but you must click **Finish** to stop
and save. Local history is stored on this Mac in the ignored `data` folder.

</details>

### 9. Connect Strava for activities and uploads

This is optional for GPX-only riding. Do it on the **Strava account whose
activities should be read and uploaded**, and use that account's own API app.
The app requests permission to read private activities and upload activities.

1. Sign in to that account at <https://www.strava.com/settings/api>. Create a
   Strava API application; Strava may require an active subscription. Fill in
   its required name, category, website, and description fields truthfully.
   For **Authorization Callback Domain**, enter exactly `localhost` (no
   `http://`, port, or slash). Follow Strava's
   [developer setup guide](https://developers.strava.com/docs/getting-started/)
   if the form has changed.
2. On the API settings page, find **Client ID** and **Client Secret**. Keep the
   secret private: do not paste it, an access token, or a refresh token into
   chat, email, screenshots, GitHub, or a shared document.
3. Keep the app's original Terminal window open. Open a **second** Terminal
   window and run:

   ```sh
   cd ~/ella_zwift
   nano strava.local.json
   ```

4. Enter the following, replacing the two placeholders with the actual values
   from Strava. Keep the straight double quotes and comma:

   ```json
   {
     "client_id": "YOUR_CLIENT_ID",
     "client_secret": "YOUR_CLIENT_SECRET"
   }
   ```

   Press **Control-O**, **Return**, and **Control-X** to save. This file is
   ignored by Git; do not commit or share it. The refresh token will be stored
   in your Mac's keychain after authorization.
5. Return to the app's original Terminal window. Stop the app with
   **Control-C**, then start it again with `python app.py` while the virtual
   environment is active. Reload `http://localhost:8765` in Chrome.
6. Click **Connect Strava**. Sign in to the intended Strava account and review
   and approve the requested permissions. Return to the app. It should show
   **Connected**. Click **Refresh activities**; use **Load older rides** if
   available. Click **Ride route** beside an activity with GPS to load it.
   Once a route is loaded, click **Add ghost** on past versions to compare
   their elapsed-time positions. Grouping is approximate.
7. For a real upload test, first check your Strava activity privacy settings.
   Load a real route, connect and enable the trainer, check the auto-upload
   box, record a short ride, and click **Finish**. Wait for an upload message;
   Strava may take extra time to process it. Check your Strava activity list.
   Uploads contain route position and recorded metrics, but no heart rate.
   This prototype does not force the uploaded activity to be private.

<details>
<summary>Troubleshooting: Strava setup, sign-in, activities, or upload fails</summary>

- If app creation is unavailable, check Strava's current subscription and
  developer requirements. New API apps are single-player: use the app
  owner's Strava account, or create a separate app under your own account.
- If **Set up Strava first** remains disabled, check the file is named exactly
  `strava.local.json` inside `~/ella_zwift`, has valid JSON and the correct
  keys, then restart the app. To check syntax without printing credentials,
  run `python -c 'import json; json.load(open("strava.local.json")); print("JSON OK")'`
  from the activated project environment.
- If the OAuth callback fails, confirm the Strava callback **domain** is
  `localhost`, and open the app at `http://localhost:8765`. Make sure you
  authorize the intended account and approve the required permissions.
- If keychain storage fails, ensure the Mac is signed in, the login keychain
  is unlocked, and dependencies were installed in the active `.venv`.
- Missing activities may have no GPS, may not be cycling activities, or may
  be outside the fetched page. Try **Load older rides** when enabled. Rate
  limits and Strava permissions can also prevent retrieval.
- If an upload fails, the app reports the error and the local ride may still
  be in **Recent rides**. This version has no UI to re-upload an old saved
  ride or export it manually; do not assume connecting Strava later will
  upload it. Before retrying with another ride, check Strava to avoid
  duplicates. If Strava is still processing, wait and check its activity list.

</details>

### 10. Set up the public Strava webhook

This is needed for the app's **deauthorization-event monitoring**, not for
the first GPX ride. The localhost service cannot receive Strava callbacks
directly. The Worker receives event metadata; it stores a subscription ID and
revocation flag, not ride data or access tokens. The Strava client secret and
webhook secrets are stored as Cloudflare Worker secrets. Use a separate Strava
API app, Worker, KV namespace, and secrets per rider/account: this prototype
has one shared revocation flag and is not a multi-user service.

1. Create/sign in to a [Cloudflare account](https://dash.cloudflare.com/).
   Review its plan limits and potential costs. Make sure section 9 works.
2. Install a supported **Node.js LTS** macOS installer from
   <https://nodejs.org/en/download>. Node includes npm. Open a **new** Terminal
   window, then check `node --version` and `npm --version`. Wrangler supports
   current, active LTS, and maintenance LTS Node versions, and currently
   requires macOS 13.5 or newer. See
   [Wrangler requirements](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
3. In that Terminal window enter:

   ```sh
   cd ~/ella_zwift/cloudflare
   npx wrangler@latest login
   ```

   If npm asks whether to install Wrangler, review the package name and
   approve. A browser page should open; sign in to the intended Cloudflare
   account and approve the requested access. Return to Terminal.
4. Run `npx wrangler@latest kv namespace create WEBHOOK_STATE`. Copy the
   returned namespace **id**. Open the local configuration:

   ```sh
   nano wrangler.toml
   ```

   Replace only `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` inside the quotes with the
   returned ID. Each Cloudflare account should have its own namespace. If a
   Worker named `ella-zwift-strava-webhook` already exists in your account,
   change the `name` value to a unique lowercase, hyphenated name **before**
   deploying so you do not overwrite an existing Worker. Save with
   **Control-O**, **Return**, **Control-X**. This is a local change to a
   tracked file; do not commit your account-specific configuration.
5. Create **two different random secrets** by running the command below twice.
   Save the first privately as `VERIFY_TOKEN` and the second as `ADMIN_TOKEN`
   in a password manager. They will appear in your Terminal: keep the screen
   private and never paste them into chat or GitHub.

   ```sh
   python3 -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

6. First create the Worker by running `npx wrangler@latest deploy` from
   `~/ella_zwift/cloudflare`. If asked to create a workers.dev subdomain,
   follow Cloudflare's prompt. Then run these four commands **one at a time**.
   When prompted, paste the requested value and press Return. The values may
   not appear on screen as you type. Use the same Strava Client ID and Client
   Secret from section 9, then your two distinct random values.

   ```sh
   npx wrangler@latest secret put STRAVA_CLIENT_ID
   npx wrangler@latest secret put STRAVA_CLIENT_SECRET
   npx wrangler@latest secret put VERIFY_TOKEN
   npx wrangler@latest secret put ADMIN_TOKEN
   ```

   Each secret update deploys a new Worker version. Copy the HTTPS Worker URL
   printed by the initial deployment; do not add `/strava/webhook` to it for
   the next step. Do not register the webhook until all four secrets are set.
7. In Terminal, run `cd ~/ella_zwift` and `nano strava.local.json`. Add the
   last two fields below while keeping your existing Client ID and Secret:

   ```json
   {
     "client_id": "YOUR_CLIENT_ID",
     "client_secret": "YOUR_CLIENT_SECRET",
     "webhook_status_url": "https://YOUR-WORKER.workers.dev",
     "webhook_admin_token": "YOUR_ADMIN_TOKEN"
   }
   ```

   Replace the placeholders with your real values, including the same
   `ADMIN_TOKEN` from step 5. Use the Worker's HTTPS **origin only**, no
   trailing path or query. Save with **Control-O**, **Return**, **Control-X**.
8. Restart `python app.py` in the app's activated Terminal window, reload
   Chrome, connect Strava if needed, and click **Register webhook**. After
   registration and a reload, the Strava panel should say the webhook is
   active. If the Worker is configured but unreachable, Strava API calls fail
   closed; local GPX riding remains available.

<details>
<summary>Troubleshooting: Node, Cloudflare, webhook deployment, or registration fails</summary>

- If `node` or `npx` is not found, reopen Terminal after installing Node LTS.
  If Wrangler rejects the version, compare `node --version` and your macOS
  version with the linked current requirements.
- If login cannot open a browser, follow the URL shown in Terminal and approve
  access to the intended Cloudflare account. An account may need to complete
  Workers setup or provide billing details under Cloudflare's current rules.
- If deployment reports an invalid KV namespace, recheck the ID in
  `cloudflare/wrangler.toml`, the Cloudflare account, and the binding name
  `WEBHOOK_STATE`. Do not replace the ID with the namespace name.
- If **Register webhook** is disabled, first connect Strava and check that the
  Worker URL and admin token in `strava.local.json` match the deployed Worker.
  Restart the Python app after changing the file. If registration reports an
  existing subscription at another URL, Strava allows one subscription per
  app: do not delete or migrate it without understanding which existing
  integration uses it.
- If status does not update immediately, Cloudflare KV is eventually
  consistent; changes can take 60 seconds or longer to appear. The webhook
  prototype is untested with live Strava events and does not cryptographically
  authenticate individual event POSTs. “Active” means a subscription ID is
  stored, not proof that deauthorization delivery has been verified.
- If the Worker is unreachable, Strava reads and uploads stop until it is
  reachable again. The local ride and GPX features can still be used. Do not
  post secrets when asking for help; share only the error text after removing
  credentials and personal information.

</details>

### 11. Next time, update, and protect your data

1. To start the app on another day, open Terminal and run:

   ```sh
   cd ~/ella_zwift
   source .venv/bin/activate
   python app.py
   ```

   Open `http://localhost:8765` in Chrome, import/select a route, connect the
   KICKR, and explicitly enable control. Finish and save before stopping the
   service with Control-C.
2. To get future updates, first stop the app, open GitHub Desktop, select
   `ella_zwift`, click **Fetch origin**, and if offered click **Pull origin**.
   Review any warning about local changes rather than overwriting them. If
   `requirements.txt` changed, activate `.venv` and rerun
   `python -m pip install -r requirements.txt`. Then start the app again.
3. Rides are local to this Mac. Back up `data` securely if you want to keep
   them; it can contain personal route and activity information. The ignored
   `strava.local.json` contains secrets and the keychain holds the refresh
   token. Do not commit these or share them in screenshots. Auto-upload is
   remembered on this browser, so check the box's state before each ride.

<details>
<summary>Troubleshooting: an update conflicts or I move to another Mac</summary>

If Desktop reports local changes or a conflict, do not discard files blindly.
The Cloudflare setup modifies the tracked `cloudflare/wrangler.toml` locally;
preserve its account-specific namespace ID and Worker name before resolving an
update. A fresh clone on a different Mac does not copy local rides, local
configuration, or keychain entries. Set up the new Mac again and transfer
personal data only through a secure method. Connecting to Strava on a new Mac
requires authorization on that Mac. Do not copy secrets into the repository.

</details>

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
   First run `npx wrangler@latest deploy` to create the Worker. Then enter each
   value when prompted by these commands, along with the same Strava Client ID
   and Client Secret used in `strava.local.json`:

   ```sh
   npx wrangler@latest secret put STRAVA_CLIENT_ID
   npx wrangler@latest secret put STRAVA_CLIENT_SECRET
   npx wrangler@latest secret put VERIFY_TOKEN
   npx wrangler@latest secret put ADMIN_TOKEN
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
- No Street View, app accounts, hosted ride app, or cloud ride storage;
  the optional webhook uses a public Worker and cloud KV state

Strava uploads are asynchronous. The app waits for Strava's processing result
and displays the resulting activity ID when available.

## Checks

```powershell
python -m unittest discover -s tests -v
python -m py_compile app.py
```
