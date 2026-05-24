#!/bin/sh

# Extracts the language part of a given locale, e.g. "en_US.UTF-8"
# yields "en". Often $LANG will be passed as the argument.
language_code_from_locale () {
    echo "${1}" | sed "s,\(_\|\.\).*$,,"
}

# Prints the path to the localized (according to the environment's
# LANG) version of `page` in the local copy of Tails' website. `page`
# should specify only the name of the page, not the language code (of
# course!) or the ".html" extension. If a localized page doesn't exist
# the default is the English version.
localized_tails_doc_page () {
    local page="${1}"
    local lang_code

    # Check if LANG contains any '/' or '%' characters, which is the
    # same sudo does to validate environment variables.
    # See https://github.com/sudo-project/sudo/blob/d7b8f3ffbf278ba87946851f8d8c1b21e3fe4818/plugins/sudoers/env.c#L687
    # Rationale: sudo and possibly other programs allow passing LANG.
    # While sudo validates it, other programs might not.
    if echo "${LANG}" | grep -q '[/%]'; then
        echo >&2 "LANG contains invalid characters, not using it: '${LANG}'"
    else
        lang_code="$(language_code_from_locale "${LANG}")"
    fi

    local try_page
    for locale in "${lang_code}" "en"; do
        try_page="${page}.${locale}.html"
        if [ -r "${try_page}" ]; then
            echo "${try_page}"
            return 0
        fi
    done
    return 1
}
