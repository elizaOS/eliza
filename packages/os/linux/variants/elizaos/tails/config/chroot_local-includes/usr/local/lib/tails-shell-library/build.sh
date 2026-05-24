#!/bin/sh

# Import is_package_installed
. /usr/local/lib/tails-shell-library/common.sh

strip_nondeterminism_wrapper() {
    apt-get --yes install strip-nondeterminism
    strip-nondeterminism "${@}"
    apt-get --yes purge strip-nondeterminism '^libfile-stripnondeterminism-perl'
}

# Ensure that the packages whose names are passed as arguments are
# installed. If they are installed now, they will be marked as
# "automatically installed" so the next `apt-get autoremove` action
# *unless* they are later explicitly installed (or other packages
# depends on them).
ensure_hook_dependency_is_installed() {
    # Filter out already installed packages from $@.
    for p in "${@}"; do
        shift
        if ! echo "${p}" | grep -q --extended-regexp '^[a-z0-9.+-]+$'; then
            echo "ensure_hook_dependency_is_installed():" \
                "doesn't look like a package name: ${p}" >&2
            exit 1
        fi
        if is_package_installed "${p}"; then
            continue
        fi
        set -- "${@}" "${p}"
    done
    if [ -z "${*}" ]; then
        return
    fi
    apt-get install --yes "${@}"
    apt-mark auto "${@}"
}

install_fake_package() {
    local name version section provides tmp control_file
    name="${1}"
    version="${2}"
    section="${3:-misc}"
    provides="${4:-}"
    ensure_hook_dependency_is_installed equivs
    tmp="$(mktemp -d)"
    control_file="${tmp}/${name}_${version}.control"
    cat >"${control_file}" <<EOF
Section: ${section}
Priority: optional
Homepage: https://tails.net/
Standards-Version: 3.9.6

Package: ${name}
Version: ${version}
Maintainer: Tails developers <foundations@tails.net>
Architecture: all
Provides: ${provides}
Description: (Fake) ${name}
 Dummy packaged used to meet some dependency without installing the
 real ${name} package.
EOF
    (
        cd "${tmp}"
        equivs-build "${control_file}"
        dpkg -i "${tmp}/${name}_${version}_all.deb"
    )
    rm -R "${tmp}"
}
