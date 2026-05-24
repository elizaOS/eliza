SUMMARY = "elizaOS confidential-profile policy + measured-boot enforcement artifacts"
DESCRIPTION = "Installs the ELIZAOS_PROFILE=confidential TEE policy blob, its \
golden TEE measurements, and the boot-consumable enforcement artifacts \
(kernel cmdline fragment, sysctl drop-in, systemd masked-units list) into the \
measured rootfs. These are the static files measured into measurements.policy \
and applied at boot (plan packages/os/docs/tee-os-implementation-plan.md \
§3-§4, OS-1/OS-3). The agent container image and in-domain \
attestation agent are installed by a separate recipe that is BLOCKED on a \
build host (see README)."
HOMEPAGE = "https://elizaos.ai"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

# Resolve file:// SRC_URI entries against the real in-tree confidential directory
# (packages/os/linux/confidential), three levels up from this recipe. Every path
# below is a file that exists in-tree and is generated/checked by the OS-3 gates.
FILESEXTRAPATHS:prepend := "${THISDIR}/../../../:"

SRC_URI = "\
    file://policy/confidential-policy.json \
    file://cmdline.conf \
    file://sysctl.d/99-confidential.conf \
    file://masked-units.txt \
    file://image-manifest.example.json \
"

# No compilation; this is a pure data/staging recipe.
S = "${WORKDIR}"

do_install() {
    # 1. TEE policy blob — measured into measurements.policy (canonical digest).
    install -d ${D}${sysconfdir}/elizaos/tee
    install -m 0444 ${WORKDIR}/policy/confidential-policy.json \
        ${D}${sysconfdir}/elizaos/tee/confidential-policy.json

    # 2. Golden image manifest (the "image is the policy" record). The signed
    #    tee-measurements.json itself is produced by generate-tee-measurements.mjs
    #    at release time and installed by the release recipe; this manifest lets a
    #    verifier recompute the golden digests offline.
    install -m 0444 ${WORKDIR}/image-manifest.example.json \
        ${D}${sysconfdir}/elizaos/tee/image-manifest.json

    # 3. Kernel cmdline fragment (noswap/nohibernate/nosmt/lockdown/...). Consumed
    #    by the bootloader recipe (meta-dstack) which appends it to the measured
    #    kernel command line.
    install -d ${D}${sysconfdir}/elizaos/confidential
    install -m 0444 ${WORKDIR}/cmdline.conf \
        ${D}${sysconfdir}/elizaos/confidential/cmdline.conf

    # 4. sysctl drop-in (kptr_restrict=2, perf_event_paranoid=3, dmesg_restrict=1,
    #    kexec_load_disabled=1, ...). Applied at boot by systemd-sysctl.
    install -d ${D}${sysconfdir}/sysctl.d
    install -m 0444 ${WORKDIR}/sysctl.d/99-confidential.conf \
        ${D}${sysconfdir}/sysctl.d/99-confidential.conf

    # 5. systemd masked units (swap.target/hibernate.target/kdump.service ...).
    #    Each listed unit is masked into a symlink to /dev/null so it can never
    #    start, matching the policy's enforcement form.
    install -d ${D}${sysconfdir}/systemd/system
    install -m 0444 ${WORKDIR}/masked-units.txt \
        ${D}${sysconfdir}/elizaos/confidential/masked-units.txt
    while read -r unit; do
        case "${unit}" in
            ""|\#*) continue ;;
        esac
        ln -sf /dev/null ${D}${sysconfdir}/systemd/system/${unit}
    done < ${WORKDIR}/masked-units.txt
}

FILES:${PN} = "\
    ${sysconfdir}/elizaos \
    ${sysconfdir}/sysctl.d/99-confidential.conf \
    ${sysconfdir}/systemd/system \
"
