# Mark translatable strings, but don't actually translate them, as we
# delegate this to TranslatableWindow that handles on-the-fly language changes
def _(text: str) -> str:
    return text
