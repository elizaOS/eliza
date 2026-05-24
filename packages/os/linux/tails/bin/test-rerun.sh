#!/bin/bash

if [ "$(id -u)" -ne 0 ]; then
    exec sudo \
        VERSION="$VERSION" ISOS="$ISOS" PREVIOUS_STABLE_VERSION="$PREVIOUS_STABLE_VERSION" \
        tmpdir="$HOME/tails/release/test-results/${VERSION:?}" \
        "$0" "$@"
fi

(
    args=(--tmpdir "$tmpdir" --capture --view
        --iso "${ISOS:?}/tails-amd64-${VERSION:?}/tails-amd64-${VERSION:?}.iso"
        --old-iso "${ISOS}/tails-amd64-${PREVIOUS_STABLE_VERSION:?}/tails-amd64-${PREVIOUS_STABLE_VERSION:?}.iso"
    )

    # When running test suite during release, it's very common to go AFK while the test suite is running. So let's make sure Chutney successfully bootstrapped so
    # you don't risk coming back hours later, having to restart from
    # scratch. The following command will exit when Chutney has successfully
    # bootstrapped, or time out after ten minutes, which indicates that
    # something is wrong:
    (
        sleep 10
        if ! env CHUTNEY_DATA_DIR="${tmpdir}/chutney-data" \
            CHUTNEY_START_TIME=600 \
            submodules/chutney/chutney wait_for_bootstrap || exit 1; then
            echo "ERROR: chutney not ready" >&2
            exit 1
        fi
    ) &
    ./run_test_suite "${args[@]}" "$@"

    while true; do
        ./run_test_suite "${args[@]}" "@$(find "${tmpdir:?}" -maxdepth 2 -type f -name rerun.txt -print0 | xargs -0 ls -t1 | stest -s | shuf -n1)"
        sleep 3
    done
)
