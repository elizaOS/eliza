#!/bin/bash
# -*- mode: sh; sh-basic-offset: 4; indent-tabs-mode: nil; -*-
# vim: set filetype=sh sw=4 sts=4 expandtab autoindent:

set -e
set -u
set -o pipefail

LANGUAGES=${@:-ca de es fr it pt ru}

GIT_TOPLEVEL_DIR=$(git rev-parse --show-toplevel)

# Import count_msgids() and count_translated_strings()
. "${GIT_TOPLEVEL_DIR}/config/chroot_local-includes/usr/local/lib/tails-shell-library/po.sh"

statistics () {
    PO_MESSAGES=$(mktemp -t "XXXXXX.$lang.po")
    msgcat --files-from="$PO_FILES" --output="$PO_MESSAGES"
    TOTAL=$(msgattrib --no-obsolete "$PO_MESSAGES" | count_msgids)
    FUZZY=$(msgattrib --only-fuzzy --no-obsolete "$PO_MESSAGES" | count_msgids)
    TRANSLATED=$(count_translated_strings < "$PO_MESSAGES")
    echo "  - $lang: $((TRANSLATED*100/TOTAL))% ($TRANSLATED) strings translated, $((FUZZY*100/TOTAL))% strings fuzzy"
    rm -f "$PO_FILES" "$PO_MESSAGES"
}

intltool_report () {
    rm -rf tmp/pot
    "${GIT_TOPLEVEL_DIR}/refresh-translations" --keep-tmp-pot
    rm -rf po.orig
    cp -a po po.orig
    (
        cd po
        intltool-update --report
    )
    rm -r po
    mv po.orig po
}

# sanity checks

if pwd | grep -qs 'wiki/src$' ; then
    WEBSITE_ROOT_DIR='.'
elif [ -d '.git' ] ; then
    WEBSITE_ROOT_DIR='wiki/src'
else
    echo >&2 "Error: $(basename "$0") is meant to be run either from the wiki/src directory,"
    echo >&2 "       or from the root of the source tree"
    exit 1
fi

# all program's PO files
echo "## All programs"
echo ""
intltool_report

# all PO files
echo ""
echo "## All the website"
echo ""

for lang in $LANGUAGES ; do
    PO_FILES="$(mktemp -t "XXXXXX.$lang")"
    find "$WEBSITE_ROOT_DIR" -iname "*.$lang.po" > "$PO_FILES"
    find "$WEBSITE_ROOT_DIR" -path "*/locale/$lang/LC_MESSAGES/*.po" >> "$PO_FILES"
    statistics "$PO_FILES"
done

# core PO files
echo ""
echo "## [[Core pages of the website|contribute/l10n_tricks/core_po_files.txt]]"
echo ""

for lang in $LANGUAGES ; do
    PO_FILES="$(mktemp -t "XXXXXX.$lang")"
    sed < "$WEBSITE_ROOT_DIR"/contribute/l10n_tricks/core_po_files.txt \
        "s/$/.$lang.po/g" \
        | sed "s,^,$WEBSITE_ROOT_DIR/," \
        > "$PO_FILES"
    statistics "$PO_FILES"
done

# core PO files (other languages)
echo ""
echo "## Core pages of the website for languages not activated on the website yet"
echo ""

for lang in ar fa id pl sr_Latn tr zh zh_TW ; do
    PO_FILES="$(mktemp -t XXXXXX.$lang)"
    sed < "$WEBSITE_ROOT_DIR"/contribute/l10n_tricks/core_po_files.txt \
        "s/$/.$lang.po/g" \
        | sed "s,^,$WEBSITE_ROOT_DIR/," \
        > "$PO_FILES"
    statistics "$PO_FILES"
done

echo
echo "(List of languages last updated on 2020-03-27.)"
