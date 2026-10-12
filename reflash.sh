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
# kills sshd so the SSH connection closes cleanly (the client exits right away
# instead of hanging until it times out), then reboots.
cat > "$R/flash.sh" <<'EOS'
curl -fsSL "$1" | xz -dc | dd of=/dev/mmcblk0 bs=4M conv=fsync status=progress
sync
echo ">>> DONE — rebooting <<<"
for p in /proc/[0-9]*; do
  read -r c 2>/dev/null < "$p/comm" || continue
  case "$c" in sshd*) kill "${p#/proc/}" 2>/dev/null ;; esac
done
sleep 2   # let the TCP close reach the client before the hard reboot
echo b > /proc/sysrq-trigger
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
  setsid sh /flash.sh "'"$IMG_URL"'" < /dev/null
'
