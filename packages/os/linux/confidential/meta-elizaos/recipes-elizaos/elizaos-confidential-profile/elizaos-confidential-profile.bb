SUMMARY = "elizaOS confidential-profile policy + measured-boot enforcement artifacts"
DESCRIPTION = "Installs confidential policy and boot settings. Release measurements \
and attestation services must be supplied by the image producer."
HOMEPAGE = "https://elizaos.ai"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

# Resolve local inputs from linux/confidential.
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

    # Example metadata is documentation, never the runtime trust record.
    install -d ${D}${docdir}/${PN}
    install -m 0444 ${WORKDIR}/image-manifest.example.json \
        ${D}${docdir}/${PN}/image-manifest.example.json

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
