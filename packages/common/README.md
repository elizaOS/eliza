# Common primitives

Pure leaf utilities shared by the Node runtime and browser clients. This package has no production dependencies, runtime state, provider configuration, app policy, or Node imports. Its purpose is to avoid a core/shared dependency cycle and duplicate security-sensitive redaction logic. App contracts belong in shared; agent execution belongs in core.
