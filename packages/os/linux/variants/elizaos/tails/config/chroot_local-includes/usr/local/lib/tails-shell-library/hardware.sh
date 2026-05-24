#!/bin/sh

get_all_ethernet_nics() {
    for i in /sys/class/net/*; do
        # type = 1 means ethernet (ARPHDR_ETHER, see Linux' sources,
        # beginning of include/linux/if_arp.h)
        if [ "$(cat "${i}"/type)" = 1 ]; then
            basename "${i}"
        fi
    done | grep -Fv --line-regexp -f /dev/fd/3  3<<EOT
$(get_all_veth_nics)
EOT
   # the above command just "removes" from the output of the for loop
   # everything that is outputted by get_all_veth_nics
   # On bash, you might have used process substitution: for-loop | grep -Fxv -f <(get_all_veth_nics)
   # but we're in posix-compatible shell scripting!
   ret=$?
   if [ "$ret" -lt 2 ]; then
       return 0
   else
       return $ret
   fi
}

get_all_veth_nics() {
    ip -brief link show type veth|
        awk '{ print $1 }' |
        cut -d '@' -f 1
}

nic_exists() {
    [ -e /sys/class/net/"${1}" ]
}

nic_is_up() {
    [ "$(cat /sys/class/net/"${1}"/operstate)" = "up" ]
}

# The following "nic"-related functions require that the argument is a
# NIC that exists

nic_ipv4_addr() {
    ip addr show "${1}" | sed -n 's,^\s*inet \([0-9\.]\+\)/.*$,\1,p'
}

nic_ipv6_addr() {
    ip addr show "${1}" | sed -n 's,^\s*inet6 \([0-9a-fA-F:]\+\)/.*$,\1,p'
}

# Will just output nothing on failure
get_current_mac_of_nic() {
    local mac
    mac="$(macchanger "${1}" | sed -n "s/^Current\s*MAC:\s*\([0-9a-f:]\+\)\s.*$/\1/p" || :)"
    if echo "${mac}:" | grep -q "^\([0-9a-fA-F]\{2\}:\)\{6\}$"; then
        echo "${mac}"
    fi
}

get_module_used_by_nic() {
    basename "$(readlink "/sys/class/net/${1}/device/driver/module")"
}

get_name_of_nic() {
  vendor=$(udevadm info -x --query=property "/sys/class/net/${1}" | sed -n "s/ID_VENDOR_FROM_DATABASE='\(.*\)'/\\1/p" || : )
  device=$(udevadm info -x --query=property "/sys/class/net/${1}" | sed -n "s/ID_MODEL_FROM_DATABASE='\(.*\)'/\\1/p" || : )
  echo "${vendor} ${device}"
}

# Auxiliary function for mod_rev_dep(). It recurses over the graph of
# kernel module dependencies of $@ (note that it only works for loaded
# modules). To deal with circular dependencies a global variable
# MOD_REV_DEP_VISITED keeps track of already visited nodes, and it
# should be unset before the first call of this function.
mod_rev_dep_aux() {
  local mod
  local rev_deps
  for mod in "${@}"; do
    # shellcheck disable=SC2086
    if echo ${MOD_REV_DEP_VISITED} | grep -qw "${mod}"; then
        continue
    fi
    MOD_REV_DEP_VISITED="${MOD_REV_DEP_VISITED} ${mod}"
    # extract the "Used by" column for $mod from lsmod
    rev_deps=$(lsmod | \
               sed -n "s/^${mod}\s\+\S\+\s\+\S\+\s\+\(\S\+\)/\1/p" | \
               tr ',' ' ')
    # shellcheck disable=SC2086
    mod_rev_dep_aux ${rev_deps}
    echo "${mod}"
  done
}

# Prints a list of all loaded modules depending on $1, including $1. It's
# ordered by descending "maximum dependency distance" from $1, so the
# output is ideal if we want to unload $1 and (by necessity) all
# modules that uses $1.
mod_rev_dep() {
  MOD_REV_DEP_VISITED=""
  mod_rev_dep_aux "${1}"
}

# Unloads module $1, and all modules that (transatively) depends on
# $1 (i.e. its reverse dependencies).
unload_module_and_rev_deps() {
  # shellcheck disable=SC2046
  /sbin/modprobe -r $(mod_rev_dep "${1}")
}
