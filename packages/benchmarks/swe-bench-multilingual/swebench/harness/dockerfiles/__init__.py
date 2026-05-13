from swebench.harness.dockerfiles.c import (
    _DOCKERFILE_BASE_C,
    _DOCKERFILE_INSTANCE_C,
)
from swebench.harness.dockerfiles.go import (
    _DOCKERFILE_BASE_GO,
    _DOCKERFILE_INSTANCE_GO,
)
from swebench.harness.dockerfiles.java import (
    _DOCKERFILE_BASE_JAVA,
    _DOCKERFILE_INSTANCE_JAVA,
)
from swebench.harness.dockerfiles.javascript import (
    _DOCKERFILE_BASE_JS,
    _DOCKERFILE_BASE_JS_2,
    _DOCKERFILE_ENV_JS,
    _DOCKERFILE_INSTANCE_JS,
)
from swebench.harness.dockerfiles.python import (
    _DOCKERFILE_BASE_PY,
    _DOCKERFILE_ENV_PY,
    _DOCKERFILE_INSTANCE_PY,
)
from swebench.harness.dockerfiles.php import (
    _DOCKERFILE_BASE_PHP,
    _DOCKERFILE_INSTANCE_PHP,
)
from swebench.harness.dockerfiles.ruby import (
    _DOCKERFILE_BASE_RUBY,
    _DOCKERFILE_INSTANCE_RUBY,
)
from swebench.harness.dockerfiles.rust import (
    _DOCKERFILE_BASE_RUST,
    _DOCKERFILE_INSTANCE_RUST,
)

_DOCKERFILE_BASE = {
    "c": _DOCKERFILE_BASE_C,
    "go": _DOCKERFILE_BASE_GO,
    "py": _DOCKERFILE_BASE_PY,
    "java": _DOCKERFILE_BASE_JAVA,
    "js": _DOCKERFILE_BASE_JS,
    "php": _DOCKERFILE_BASE_PHP,
    "rb": _DOCKERFILE_BASE_RUBY,
    "rs": _DOCKERFILE_BASE_RUST,
}

_DOCKERFILE_ENV = {
    "py": _DOCKERFILE_ENV_PY,
    "js": _DOCKERFILE_ENV_JS,
}

_DOCKERFILE_INSTANCE = {
    "c": _DOCKERFILE_INSTANCE_C,
    "go": _DOCKERFILE_INSTANCE_GO,
    "py": _DOCKERFILE_INSTANCE_PY,
    "java": _DOCKERFILE_INSTANCE_JAVA,
    "js": _DOCKERFILE_INSTANCE_JS,
    "php": _DOCKERFILE_INSTANCE_PHP,
    "rb": _DOCKERFILE_INSTANCE_RUBY,
    "rs": _DOCKERFILE_INSTANCE_RUST,
}


def get_dockerfile_base(platform, arch, language, **kwargs):
    if arch == "arm64":
        conda_arch = "aarch64"
    else:
        conda_arch = arch

    # Special handling for some js repos that require a different base image.
    # If other languages also start using variants, this logic should be moved
    # to a helper function
    if "_variant" in kwargs and kwargs["_variant"] == "js_2":
        del kwargs["_variant"]
        return _DOCKERFILE_BASE_JS_2.format(platform=platform, **kwargs)

    return _DOCKERFILE_BASE[language].format(
        platform=platform, conda_arch=conda_arch, **kwargs
    )


def get_dockerfile_env(platform, arch, language, base_image_key, **kwargs):
    # Some languages do not have an environment Dockerfile. In those cases, the
    # base Dockerfile is used as the environment Dockerfile.
    dockerfile = _DOCKERFILE_ENV.get(language, _DOCKERFILE_BASE[language])

    if "_variant" in kwargs and kwargs["_variant"] == "js_2":
        del kwargs["_variant"]
        return _DOCKERFILE_BASE_JS_2.format(platform=platform, **kwargs)

    return dockerfile.format(
        platform=platform, arch=arch, base_image_key=base_image_key, **kwargs
    )


def get_dockerfile_instance(platform, language, env_image_name):
    return _DOCKERFILE_INSTANCE[language].format(
        platform=platform, env_image_name=env_image_name
    )


__all__ = [
    "get_dockerfile_base",
    "get_dockerfile_env",
    "get_dockerfile_instance",
]
