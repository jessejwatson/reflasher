#!/bin/bash
# reflash.sh — stream a fresh OS image straight onto this Pi's SD card, from RAM.
#
# Fetched from the image server, which injects IMG_URL automatically:
#     curl -fsSL http://SERVER:8080/reflash.sh | sudo bash
#
# To run standalone, set IMG_URL yourself:
#     IMG_URL=http://SERVER:8080/os.img.xz sudo -E bash reflash.sh
#
# Everything up to ">>> STREAMING TO CARD <<<" is non-destructive: if the tools
# don't stage or the download can't start, it aborts with the SD untouched.

set -e
: "${IMG_URL:?IMG_URL is not set — fetch this script from the image server, or export IMG_URL first}"
[ "$(id -u)" = 0 ] || { echo "must run as root — pipe to 'sudo bash'"; exit 1; }

R=/ramroot
# clean any leftover from a previous run so re-runs are idempotent
umount -l "$R" 2>/dev/null || true; rm -rf "$R"
mkdir -p "$R"; mount -t tmpfs -o size=64m tmpfs "$R"
mkdir -p "$R"/{proc,sys,dev,oldroot,tmp}

copy_with_libs() {
  local bin; bin="$(command -v "$1")" || { echo "!! missing on system: $1"; exit 1; }
  mkdir -p "$R$(dirname "$bin")"; cp -Lp "$bin" "$R$bin"
  ldd "$bin" 2>/dev/null | grep -oE '/[^ ]+\.so[^ ]*' | while read -r l; do
    [ -e "$l" ] || continue; mkdir -p "$R$(dirname "$l")"; cp -Lp "$l" "$R$l" 2>/dev/null || true
  done
}
# full set — includes the binaries used INSIDE the pivot (chroot/mount/umount/setsid)
for b in bash sh dd cat sync xz curl chroot mount umount setsid sleep; do copy_with_libs "$b"; done

# preflight: confirm every binary actually landed in the RAM root before we pivot
for b in bash sh dd cat sync xz curl chroot mount umount setsid sleep; do
  p="$(command -v "$b")"; [ -e "$R$p" ] || { echo "!! failed to stage: $b — aborting, SD untouched"; exit 1; }
done
echo "All tools staged OK."

# the final stage, run from RAM after the pivot. Once the card is written it
# exits with the write's status and reboots a few seconds later from a
# detached process, so the SSH session ends normally and the client gets a
# real exit code (0 on success) instead of hanging or reporting 255.
cat > "$R/flash.sh" <<'EOS'
set -o pipefail
curl -fsSL "$1" | xz -dc | dd of=/dev/mmcblk0 bs=4M conv=fsync status=progress
rc=$?
sync
if [ "$rc" = 0 ]; then echo ">>> DONE — rebooting <<<"
else echo "!! write failed (exit $rc) — rebooting anyway"; fi
# fully detached (no inherited fds) so sshd can close the session before the reboot
setsid sh -c 'sleep 3; echo b > /proc/sysrq-trigger' < /dev/null > /dev/null 2>&1 &
exit "$rc"
EOS

BASH="$(command -v bash)"
mount --make-rprivate /
cd "$R"; pivot_root . oldroot
exec chroot . "$BASH" -c '
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin
  mount -t proc proc /proc
  mount -t devtmpfs dev /dev
  umount -l /oldroot
  echo 1 > /proc/sys/kernel/sysrq
  echo ">>> STREAMING TO CARD — do not power off <<<"
  setsid bash /flash.sh "'"$IMG_URL"'" < /dev/null
'
