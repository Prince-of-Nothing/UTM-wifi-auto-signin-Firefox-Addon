#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY. Never ship this, and never sign a build made with it.
#
#   ./scripts/dev.sh run     # throwaway Firefox profile + temporary (unsigned) addon
#   ./scripts/dev.sh captive # same, but forces firefox to treat the network as a
#                            # captive portal so the redirect-capture path runs
#   ./scripts/dev.sh test    # jsdom test of content.js against a replica of auth.html
#   ./scripts/dev.sh clean   # delete the throwaway profile
#
# dev.sh run|captive also flips config.json into debug mode (DEBUG:true + the
# hardcoded fallback portalUrl) for the session and restores it on exit, so a
# signed build can never accidentally inherit the test hooks.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${DEV_PROFILE:-$HOME/.utm-autoconnect-devprofile}"
CFG=extension/config.json

enable_debug() {
  cp "$CFG" "$CFG.devbak"
  python3 - "$CFG" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["DEBUG"] = True
d.setdefault("portalUrl", "https://sb.sdn.utm.md:19008/portalpage/0103a076acdb455c96798816d6be7008/20231203231637/pc/auth.html?apmac=e86de9401260&uaddress=172.18.5.7&umac=d29c130b79a6&authType=2&lang=custom&ssid=VVRNLVdpTmV0VW5pX0dVRVNU&successUrl=0000000100000001CFA077962079A1EE2B6A38EEB8261951BD207BCDF92CB5E8E99E47C7DED9A80B4863E3EB5C3BE747A96720BE89365603&pushPageId=72a0ffe6-8e46-4b87-a0bd-cf3586f0d510")
json.dump(d, open(p, "w"), indent=2)
PY
  trap restore_debug EXIT
}
restore_debug() {
  [ -f "$CFG.devbak" ] && mv "$CFG.devbak" "$CFG" && echo "restored $CFG (DEBUG off, no hardcoded URL)"
}

case "${1:-run}" in
  run)
    enable_debug
    npx --yes web-ext run --source-dir extension --firefox-profile "$PROFILE" --keep-profile-changes
    ;;
  captive)
    enable_debug
    printf '{"captivetest": true}' > /tmp/utm-captive-prefs.json
    npx --yes web-ext run --source-dir extension --firefox-profile "$PROFILE" \
      --keep-profile-changes --pref network.captive-portal-service.enabled=true \
      --pref network.portal_url=http://detectportal.firefox.com/canonical.html \
      --pref browser.privatebrowsing.autostart=false
    ;;
  test)
    node scripts/test-content.js
    ;;
  clean)
    rm -rf "$PROFILE"; echo "removed $PROFILE"
    ;;
  *)
    echo "usage: $0 [run|captive|test|clean]" >&2; exit 2;;
esac
