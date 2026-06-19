#!/bin/sh

set -e
set -u

# Make /etc/bash.bashrc source /etc/bash.bashrc.d/*

echo "Updating /etc/bash.bashrc"

cat <<'EOF'>> /etc/bash.bashrc
# The following code snippet is added by 'config/chroot_local-hooks/51-update-bash.bashrc'

for file in /etc/bash.bashrc.d/*;
do
    source "$file"
done
EOF
