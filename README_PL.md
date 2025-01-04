# Eliza 🤖

<div align="center">
  <img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />
</div>

<div align="center">

📖 [Dokumentacja](https://elizaos.github.io/eliza/) | 🎯 [Przykłady](https://github.com/thejoven/awesome-eliza)

</div>

## ✨ Cechy modelu:

- 🛠️ Pełne wsparcie dla Discorda, Telegrama i Twittera
- 🔗 Wsparcie dla wszystkich modeli AI (Llama, Grok, OpenAI, Anthropic, itd.)
- 👥 Wiele osobowości jednocześnie oraz wsparcie dla pokoi
- 📚 Prosta konstrukcja i łatwość modyfikacji ustawień
- 💾 Przywracalna pamięć i opcja przechowywania dokumentów
- 🚀 Wiele możliwości rozszerzeń - twórz własne klienty, aplikacje itd
- ☁️ Wsparcie dla szerokiej gamy modeli (local Llama, OpenAI, Anthropic, Groq, etc.)
- 📦 To po prostu działa!

## Poradniki wideo

[AI Agent Dev School](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Przykłady zastosowania

- 🤖 Chatboty
- 🕵️ Autonomiczni Agenci
- 📈 Utrzymanie procesów biznesowych
- 🎮 Zaplecze dla postaci NPC w grach
- 🧠 Handel

## 🚀 Jak zacząć?

### Wstępne wymagania:

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

> **Notka dla użytkowników Windowsa:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) jest wymagane!.

### Użycie startera (Rekomendowane)

```bash
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
pnpm i && pnpm build && pnpm start
```
Gdy agent się uruchomi, powinien pojawić się komunikat aby uruchomić komendę "pnpm start:client".
Wtedy trzeba odpalić drugi terminal, przejść do tego samego folderu, w którym mamy sklonowany kod z Githuba i odpalić tą komendę, aby być w stanie rozpocząć konwersację z naszym botem.
```bash
pnpm start:client
```

Następnie zapoznaj się z [Dokumentacją](https://elizaos.github.io/eliza/). Tam jest szcegółowo opisane, jak modyfikować i dopasować Elizę do własnych potrzeb.

### Manualny start (Przeznaczone dla osób, które wiedzą, co robią)

```bash
# Sklonuj repozytorium
git clone https://github.com/elizaos/eliza.git

# Sprawdź, czy na pewno masz najnowszą wersję
# Projekt rozrasta się bardzo szybko, dlatego zalecane jest aby często sprawdzać wersję
git checkout $(git describe --tags --abbrev=0)
```

### Start przy użyciu Gitpod'a

[![Otwórz w Gitpodzie](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/elizaos/eliza/tree/main)

### Edytuj plik .env

Zmień nazwę pliku .env.example na .env i wypełnij wartości zmiennych, które będą potrzebne do uruchomienia aplikacji.

```
cp .env.example .env
```

Uwaga: .env jest opcjonalne. Jeżeli planujesz stawiać więcej niż jedną postać, zalecane jest korzystanie z plików JSON dedykowanych dla charakterów. Będzie to bardziej przejrzyste i łatwiejsze do znalezienia gdy trzeba będzie wprowadzić jakieś zmiany.

### Automatyczny start Elizy

Ta komenda postawi projekt i uruchomi bota z domyślnym charakterem.

```bash
sh scripts/start.sh
```

### Edycja pliku postaci

1. Otwórz `packages/core/src/defaultCharacter.ts` aby zmodyfikować postać. Odkomentuj i edytuj.

2. Aby załadować niestandardowe osobowości:
    - Uzyj komendy `pnpm start --characters="path/to/your/character.json"`
    - Wiele plików z osobowościami może być załadowana jednocześnie
3. Połącz z platformą X (niegdyś Twitter)
    - zamień `"clients": []` na `"clients": ["twitter"]` w pliku osobowości aby połączyć z X

### Manualny Start Elizy

```bash
pnpm i
pnpm build
pnpm start

# Projekt rozwija się bardzo szybko, dlatego jeżeli robisz sobie przerwę na jakiś czas i wejdzie w międzyczasie dużo zmian, dobrze jest użyć tej komendy:
pnpm clean
```

#### Dodatkowe wymagania

Możesz musieć zainstalować pakiet Sharp. Jeżeli przy odpalaniu projektu wyskakuje błąd, spróbuj go zainstalować tą komendą:

```
pnpm install --include=optional sharp
```

### Społeczność i kontakt

- [GitHub Issues](https://github.com/elizaos/eliza/issues). Korzystaj w przypadku gdy napotkasz na jakieś bugi podczas uzywania Elizy, lub masz jakieś propozycje rozwoju.
- [Discord](https://discord.gg/ai16z). Używaj, gdy chcesz się pochwalić swoją aplikacją lub po prostu pogadać z kimś.

## Osoby zaangażowane w rozwój:

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" />
</a>

## Historia gwiazdek

[![Wykres historii gwiazdek](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)
