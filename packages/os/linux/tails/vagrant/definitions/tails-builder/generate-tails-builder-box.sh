#!/bin/sh

set -e
set -u
set -x

GIT_DIR="$(git rev-parse --show-toplevel)"

build_setting() {
    ruby -I "${GIT_DIR}/vagrant/lib" \
        -e "require 'tails_build_settings.rb'; print ${1}"
}

get_serial() {
    (
        cd "${GIT_DIR}/vagrant/definitions/tails-builder/" &&
            "${GIT_DIR}"/auto/scripts/apt-snapshots-serials \
                cat --print-serials-only "${1}"
    )
}

SPECFILE="$(mktemp tmp.tails-builder-spec-XXXXXXXXX.yml --tmpdir)"
TARGET_NAME="$(build_setting box_name)"
TARGET_FS_TAR="${TARGET_NAME}.tar"
TARGET_IMG="${TARGET_NAME}.img"
TARGET_QCOW2="${TARGET_NAME}.qcow2"
TARGET_BOX="${TARGET_NAME}.box"
LOG_VMDB2="vmdb2.log"
DISTRIBUTION="$(build_setting DISTRIBUTION)"
HOSTNAME="vagrant-${DISTRIBUTION}"
USERNAME="vagrant"
PASSWORD="vagrant"

DEBIAN_SERIAL="$(get_serial debian)"
DEBIAN_SECURITY_SERIAL="$(get_serial debian-security)"

# Input keyring contains concatenated armored certificates.  Join them
# into the standard form for communicating OpenPGP keyrings.
DEBOOTSTRAP_KEYRING="$(mktemp --tmpdir tmp.debootstrap-gnupg-XXXXXXXX)"
"${GIT_DIR}/auto/scripts/utils.sh" \
    pgp_flatten_keyring config/chroot_sources/tails.chroot.gpg \
    >"${DEBOOTSTRAP_KEYRING}"

trap 'rm --preserve-root=all -rf "${SPECFILE}" "${TARGET_IMG}" "${TARGET_QCOW2}" "${TARGET_FS_TAR}" "${DEBOOTSTRAP_KEYRING}"' EXIT

# Create specification file for vmdb2
cat >"${SPECFILE}" <<EOF
steps:
  - mkimg: "{{ output }}"
    size: 20G

  - mklabel: msdos
    device: "{{ output }}"

  - mkpart: primary
    device: "{{ output }}"
    start: 1M
    end: 10M
    tag: unused

  - mkpart: primary
    device: "{{ output }}"
    start: 10M
    end: 100%
    tag: rootfs

  - kpartx: "{{ output }}"

  - mkfs: ext4
    partition: rootfs
    label: smoke

  - mount: rootfs

  - debootstrap: ${DISTRIBUTION}
    mirror: http://time-based.snapshots.deb.tails.boum.org/debian/${DEBIAN_SERIAL}
    keyring: ${DEBOOTSTRAP_KEYRING}
    target: rootfs

  - virtual-filesystems: rootfs

  # Install the archive cert so that we can use it to authenticate the
  # Tails repositories.
  - copy-file: /usr/share/keyrings/tails-archive-keyring.gpg
    src: ${DEBOOTSTRAP_KEYRING}

  - create-file: /etc/network/interfaces.d/wired
    contents: |
      auto eth0
      iface eth0 inet dhcp
      iface eth0 inet6 auto

  - chroot: rootfs
    shell: |
      echo ${HOSTNAME} > /etc/hostname
      echo 127.0.0.1 ${HOSTNAME} >> /etc/hosts

  - create-file: /etc/systemd/system/tmp.mount
    contents: |

  - create-file: /etc/apt/apt.conf.d/99recommends
    contents: |
      APT::Install-Recommends "false";
      APT::Install-Suggests "false";

  - create-file: /etc/apt/apt.conf.d/99retries
    contents: |
      APT::Acquire::Retries "20";

  # This effectively disables apt-daily*.{timer,service}, which might
  # interfere with an ongoing build. We run apt-get
  # {update,dist-upgrade,clean} ourselves in setup-tails-builder.
  - create-file: /etc/apt/apt.conf.d/99periodic
    contents: |
      APT::Periodic::Enable "0";

  # This entry is written by debootstrap and we need to add Tails'
  # signing key.
  - chroot: rootfs
    shell: |
      sed -e 's#^deb #deb [signed-by=/usr/share/keyrings/tails-archive-keyring.gpg] #' -i /etc/apt/sources.list

  - chroot: rootfs
    shell: |
      sed -e 's/${DISTRIBUTION}/${DISTRIBUTION}-updates/' /etc/apt/sources.list \\
        > "/etc/apt/sources.list.d/${DISTRIBUTION}-updates.list"

  - chroot: rootfs
    shell: |
      sed -e 's/${DISTRIBUTION}/${DISTRIBUTION}-backports/' /etc/apt/sources.list \\
        > "/etc/apt/sources.list.d/${DISTRIBUTION}-backports.list"

  - create-file: /etc/apt/sources.list.d/${DISTRIBUTION}-security.list
    contents: |
      deb [signed-by=/usr/share/keyrings/tails-archive-keyring.gpg] http://time-based.snapshots.deb.tails.boum.org/debian-security/${DEBIAN_SECURITY_SERIAL}/ ${DISTRIBUTION}-security main

  - create-file: /etc/apt/preferences.d/${DISTRIBUTION}-backports
    contents: |
      Package: *
      Pin: release n=${DISTRIBUTION}-backports
      Pin-Priority: 100

  # Install ikiwiki from Forky
  - chroot: rootfs
    shell: |
      sed -e 's/${DISTRIBUTION}/forky/' /etc/apt/sources.list \\
        > "/etc/apt/sources.list.d/forky.list"

  - create-file: /etc/apt/preferences.d/ikiwiki
    contents: |
      Package: ikiwiki
      Pin: release n=forky
      Pin-Priority: 1000

  - create-file: /etc/apt/preferences.d/forky
    contents: |
      Package: *
      Pin: release n=forky
      Pin-Priority: 1

  - chroot: rootfs
    shell: apt update

  - apt: install
    packages:
      - apt-cacher-ng
      - ca-certificates
      - curl
      # Install dbus to ensure we can use timedatectl
      - dbus
      - debootstrap
      - dosfstools
      - dpkg-dev
      - gdisk
      - gettext
      - gir1.2-udisks-2.0
      - git
      - gnupg
      - grub2
      - ikiwiki
      - intltool
      - libfile-slurp-perl
      - libimage-magick-perl
      - liblist-moreutils-perl
      - libtimedate-perl
      - libyaml-syck-perl
      - linux-image-amd64
      - lsof
      - make
      - mtools
      - openssh-server
      - po4a
      - psmisc
      - python3-gi
      - rsync
      - ruby
      - sudo
      - systemd-timesyncd
      - time
      - udisks2
      - wget
      - zstd
    tag: rootfs

  - chroot: rootfs
    shell: apt-get -y dist-upgrade

  - chroot: rootfs
    shell: |
      # Disable DNS checks to speed-up SSH logins
      echo "UseDNS no" >>/etc/ssh/sshd_config
      # By default, Debian's ssh client forwards the locale env vars, and
      # by default, Debian's sshd accepts them. The locale used while
      # building could have effects on the resulting image, so let's fix
      # on a single locale for all (namely the one we won't purge below).
      sed -i 's/^AcceptEnv/#AcceptEnv/' /etc/ssh/sshd_config

  - create-file: /tmp/localepurge.txt
    contents: |
      localepurge  localepurge/dontbothernew     boolean false
      localepurge  localepurge/quickndirtycalc   boolean true
      localepurge  localepurge/mandelete         boolean true
      localepurge  localepurge/use-dpkg-feature  boolean false
      localepurge  localepurge/showfreedspace    boolean true
      localepurge  localepurge/verbose           boolean false
      localepurge  localepurge/remove_no         note
      localepurge  localepurge/nopurge           multiselect en, en_US, en_US.UTF-8
      localepurge  localepurge/none_selected     boolean false

  - chroot: rootfs
    shell: |
      debconf-set-selections < /tmp/localepurge.txt
      apt-get -y install localepurge
      localepurge
      apt-get -y remove localepurge
      rm -f /tmp/localepurge.txt

  # By default we reboot the system between each build, which makes this
  # timer useless. Besides, it is started 15 minutes after boot, which
  # has potential to interfere with an ongoing build.
  - chroot: rootfs
    shell: systemctl mask systemd-tmpfiles-clean.timer

  # We will start apt-cacher-ng inside the VM only if the vmproxy is to
  # be used.
  - chroot: rootfs
    shell: systemctl disable apt-cacher-ng.service

  # We use loop devices to extract build artifacts.  Make sure the
  # module is loaded.
  - create-file: /etc/modules-load.d/loop.conf
    contents: loop

  - create-file: /etc/default/grub.d/cmdline.cfg
    contents: |
      GRUB_CMDLINE_LINUX_DEFAULT="\$GRUB_CMDLINE_LINUX_DEFAULT mitigations=off"

  - grub: bios
    tag: rootfs
    console: serial

  - chroot: rootfs
    shell: |
      adduser --gecos '' --disabled-password ${USERNAME}
      echo "${USERNAME}:${PASSWORD}" | chpasswd
      echo "${USERNAME} ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/${USERNAME}
      mkdir -p /home/${USERNAME}/.ssh
      chmod 0700 /home/${USERNAME}/.ssh
      chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

  # Add the unsafe public key for Vagrant that will be replaced on boot.
  - chroot: rootfs
    shell: |
      install -o 1000 -g 1000 -m 0700 /dev/null /home/${USERNAME}/.ssh/authorized_keys
      echo "ssh-rsa AAAAB3NzaC1yc2EAAAABIwAAAQEA6NF8iallvQVp22WDkTkyrtvp9eWW6A8YVr+kz4TjGYe7gHzIw+niNltGEFHzD8+v1I2YJ6oXevct1YeS0o9HZyN1Q9qgCgzUFtdOKLv6IedplqoPkcmF0aYet2PkEDo3MlTBckFXPITAMzF8dJSIFo9D8HfdOV0IAdx4O7PtixWKn5y2hMNG0zQPyUecp4pzC6kivAIhyfHilFR61RGL+GPXQ2MWZWFYbAGjyiYJnAmCP3NOTd0jMZEnDkbUvxhMmBYSdETk1rRgm+R4LOzFUGaHqHDLKLX+FIPKcF96hrucXzcWyLbIbEgE98OHlnVYCzRdK8jlqm8tehUc9c9WhQ== vagrant insecure public key" > /home/${USERNAME}/.ssh/authorized_keys

  - chroot: rootfs
    shell: |
      apt-get -y autoremove
      apt-get clean
      rm -rf \\
        /var/lib/apt/lists/* \\
        /var/lib/apt/lists/partial/* \\
        /var/cache/apt/*.bin \\
        /var/cache/apt/archives/*.deb \\
        /var/log/installer \\
        /var/lib/dhcp/*
EOF

rm -f "${TARGET_NAME}"*
# shellcheck disable=SC2154
sudo ${http_proxy:+http_proxy=$http_proxy} vmdb2 "${SPECFILE}" \
    --output "${TARGET_IMG}" --verbose --log "${LOG_VMDB2}" \
    --rootfs-tarball "${TARGET_FS_TAR}"
qemu-img convert -O qcow2 "${TARGET_IMG}" "${TARGET_QCOW2}"
bash -e -x "${GIT_DIR}/vagrant/definitions/tails-builder/create_box.sh" \
    "${TARGET_QCOW2}" "${TARGET_BOX}"
rm -f "${LOG_VMDB2}"
