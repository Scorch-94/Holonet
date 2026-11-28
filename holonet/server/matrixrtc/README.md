# MatrixRTC backend for trevors.cloud (drop-in voice)

This folder sets up voice and video calls (Element Call / MatrixRTC) for trevors.cloud, so Holonet, Element Desktop and Element X can do Discord-style drop-in voice in rooms.

> **Status: untested draft.** Written from the upstream docs, not yet run against trevors.cloud. Every production change below needs explicit approval first. Before anything here, run the read-only checks in step 0 and share the output.

## What gets deployed

| Piece | Where | What it does |
|---|---|---|
| **LiveKit** | New Linux VPS | Carries call audio/video (the "SFU") |
| **lk-jwt-service** | Same VPS | Checks a member is a real trevors.cloud user, then hands out a LiveKit access token |
| **Caddy** | Same VPS | HTTPS for both, certificate managed automatically |
| **Synapse config** | Mac Studio (existing) | Turns on the features calls need and tells clients where LiveKit is |
| **`.well-known`** | Wherever `https://trevors.cloud/.well-known/matrix/client` is served | Fallback discovery for older clients |

### Why a separate VPS

LiveKit needs a public IP and a range of inbound **UDP** ports. Docker Desktop on macOS handles UDP port ranges and host networking poorly, and home ISPs may block or NAT the traffic. A small VPS (1–2 vCPU, 1–2 GB RAM is plenty for a small community) avoids both problems. Synapse stays on the Mac Studio, and only its config changes.

The existing AWS account (which already runs coturn) is a natural place for it.

---

## Step 0: Read-only checks (Mac Studio, no changes)

```bash
docker ps --format '{{.Names}}\t{{.Image}}'
curl -s https://trevors.cloud/.well-known/matrix/client
curl -s https://matrix.trevors.cloud/_synapse/admin/v1/server_version
```

Things to look for:

- **Synapse version.** `matrix_rtc` and the transports endpoint are recent additions. Plan on upgrading to the current Synapse release if it's more than a few versions behind.
- **Database.** If Synapse still uses SQLite (`homeserver.db`), plan a move to PostgreSQL. Calls add frequent small writes.
- **Who serves `.well-known`.** The second command shows its current contents. It's needed in step 5.

## Step 1: Create the VPS and DNS record

1. Create a small Linux VPS (Ubuntu 24.04 or Debian 12) with a public IPv4 address.
2. Install Docker and the Compose plugin (`curl -fsSL https://get.docker.com | sh`).
3. At the domain provider, add an **A record**: `rtc.trevors.cloud` → the VPS's public IP.

## Step 2: Open the firewall

In the VPS provider's firewall (an AWS security group, for example) **and** any firewall on the VPS itself, allow inbound:

| Port | Protocol | Purpose |
|---|---|---|
| 80 | TCP | Caddy, for certificate issuance |
| 443 | TCP | HTTPS for the token service and LiveKit signaling |
| 7881 | TCP | LiveKit media fallback over TCP |
| 50100–50200 | UDP | LiveKit media (the main call traffic) |

Leave 7880 and 8080 closed; they're only used locally.

## Step 3: Deploy LiveKit, lk-jwt-service and Caddy (VPS)

Copy this folder to the VPS, then:

```bash
cd matrixrtc
cp .env.example .env
openssl rand -hex 32          # paste the output as LIVEKIT_SECRET in .env
nano .env                     # check RTC_DOMAIN and MATRIX_SERVER_NAME
docker compose up -d
docker compose logs -f        # Ctrl+C to stop watching
```

Check it's up:

```bash
curl -s https://rtc.trevors.cloud/livekit/jwt/healthz   # expect an OK response
curl -s https://rtc.trevors.cloud/livekit/sfu/          # expect "OK" from LiveKit
```

None of this touches the live server yet. Members are unaffected until steps 4 and 5.

## Step 4: Synapse config (Mac Studio, needs approval)

1. **Back up** `homeserver.yaml` and confirm backups of the database and media are current.
2. Merge `synapse-homeserver-additions.yaml` into `homeserver.yaml`. If `experimental_features`, `rc_message` or `rc_delayed_event_mgmt` already exist, merge into them; don't duplicate the section.
3. Restart the Synapse container and check its logs for config errors.
4. Confirm Synapse now advertises the backend (use any member's access token from Element: Settings → Help & About → Advanced → Access token, and keep it private):

```bash
curl -s -H "Authorization: Bearer <token>" \
  https://matrix.trevors.cloud/_matrix/client/unstable/org.matrix.msc4143/rtc/transports
```

Expected: a JSON list containing `https://rtc.trevors.cloud/livekit/jwt`.

**Rollback:** restore the backed-up `homeserver.yaml` and restart Synapse.

## Step 5: `.well-known` fallback (needs approval)

Add the `org.matrix.msc4143.rtc_foci` entry from `well-known-client.json` to the existing `https://trevors.cloud/.well-known/matrix/client`. **Merge it; don't replace the file.** Keep everything already in it, especially `m.homeserver`.

Newer clients use the Synapse endpoint from step 4. This entry keeps older clients working.

## Step 6: Test in the 40k Space first

1. In a test room in the 40k Space, start a call from Holonet or Element Desktop.
2. Join the same call from a second account, and from Element X on a phone using mobile data (not Wi-Fi), which proves the UDP ports are reachable from outside.
3. Leave and rejoin. The participant list should update within a few seconds, with no "ghost" participants left behind.
4. Check `docker compose logs lk-jwt-service livekit` on the VPS if anything fails.

## Step 7: Enable the voice rooms

For **Imperial Ruling Council**, **Outlander Club** and **The Executor**, check that ordinary members are allowed to join calls. In room settings → Roles & Permissions, the call-related permissions should not be restricted to moderators. Test one room before changing the others.

---

## Notes

- **coturn** stays as it is for legacy 1:1 calls. LiveKit doesn't need it.
- **Updating:** `docker compose pull && docker compose up -d` on the VPS.
- **Security:** only accounts on `trevors.cloud` can start calls (`LIVEKIT_FULL_ACCESS_HOMESERVERS`), and LiveKit won't create rooms on its own (`auto_create: false`). Keep `.env` private.
