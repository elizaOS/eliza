import apt.cache

from tailslib.locale import user_language_and_region


def thunderbird_l10n_package() -> str | None:
    (language, region) = user_language_and_region()
    apt_cache = apt.cache.Cache()

    candidates = [
        f"thunderbird-l10n-{language}-{region}",
        f"thunderbird-l10n-{language}",
    ]

    for package in candidates:
        if package in apt_cache:
            return package

    return None


def thunderbird_packages() -> set[str]:
    packages = {
        "thunderbird",
        # This list has to be kept in sync' with our list of
        # tier-1 languages:
        # https://tails.net/contribute/how/translate/#tier-1-languages
        "thunderbird-l10n-ar",
        "thunderbird-l10n-de",
        "thunderbird-l10n-es-es",
        "thunderbird-l10n-es-mx",
        "thunderbird-l10n-fr",
        "thunderbird-l10n-id",
        "thunderbird-l10n-it",
        "thunderbird-l10n-pt-br",
        "thunderbird-l10n-ru",
        "thunderbird-l10n-tr",
        "thunderbird-l10n-zh-cn",
    }
    l10n_package = thunderbird_l10n_package()
    if l10n_package is not None:
        packages |= {l10n_package}
    return packages
