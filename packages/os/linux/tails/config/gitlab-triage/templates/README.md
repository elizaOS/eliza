The files in this directory are Jinja2 templates, that use non-default start/end
block/variable strings, in order not to conflict with gitlab-triage's own
templating syntax.

They are processed and rendered by
`config/gitlab-triage/bin/generate-stalled-policy`.
