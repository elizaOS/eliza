# Eliza

<img src="/docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

## ✨ Features

- 🛠️ Conexão completa para Discord, Twitter e Telegram
- 🔗 Suporte para todos os modelos (Llama, Grok, OpenAI, Anthropic, etc.)
- 👥 Suporte para multi-agente e salas
- 📚 Fácil interação com seus documentos
- 💾 Memória recuperável e armazenamento de documentos
- 🚀 Altamente extensível - crie suas próprias ações e clientes
- 📦 Simplesmente funciona!

## Tutoriais

[Escola Dev para Agentes IA (conteúdo em inglês)](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Em que posso usar?

- 🤖 Chatbots
- 🕵️ Agentes autônomos
- 📈 Gestão de processos empresariais
- 🎮 NPCs para o seus jogos
- 🧠 Trading

## 🚀 Começando

### Pré-requisitos

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

> **Nota para usuários de Windows:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) é obrigatório.

### Utilizando o Starter (Recomendado)

```bash
git clone https://github.com/ai16z/eliza-starter.git

cp .env.example .env

pnpm i && pnpm build && pnpm start
```

Leia a [Documentação](https://elizaos.github.io/eliza/) para aprender como customizar a sua Eliza.

### Executando Eliza manualmente (Recomendado apenas se você souber o que está fazendo)

```bash
# Clone o repositório
git clone https://github.com/ai16z/eliza.git

# Dê checkout no último release
# O projeto está em constante e rápido desenvolvimento, então recomendamos que você cheque o último release
git checkout $(git describe --tags --abbrev=0)
```

### Execute Eliza com Gitpod

[![Abrindo no Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/ai16z/eliza/tree/main)

### Edite o arquivo .env

Copie .env.example para .env e preencha os valores apropriados.

```
cp .env.example .env
```

Nota: .env é opcional. Se você estiver planejando rodar múltiplos agentes distintos, você pode passar segredos pelo JSON do personagem

### Execute Eliza automaticamente

Isso vai executar tudo que é necessário para configurar o projeto e começar o bot com o personagem padrão.

```bash
sh scripts/start.sh
```

### Edite o arquivo do personagem

1. Abra `packages/core/src/defaultCharacter.ts` para modificar o personagem padrão. Descomente e edite.

2. Para carregar personsagens customizáveis:
    - Use `pnpm start --characters="path/to/your/character.json"`
    - Múltiplos arquivos de personagem podem ser usados de forma simultânea
3. Conectando com o X (Twitter)
    - mude `"clients": []` para `"clients": ["twitter"]` no arquivo do personagem para conectar com o X

### Executando Eliza manualmente

```bash
pnpm i
pnpm build
pnpm start

# O projeto está iterando bem rápido. Se você estiver voltando depois de um tempo, talvez precise fazer uma limpeza
pnpm clean
```

#### Requerimentos adicionais

Talvez você precise instalar o Sharp. Se na hora de começar estiver apresentando algum erro, tente instalar com o seguinte comando:

```
pnpm install --include=optional sharp
```

### Comunidade & contato

- [GitHub Issues](https://github.com/ai16z/eliza/issues). Melhor utilizado para: bugs que você encontrar utilizando a Eliza, e propostas de features.
- [Discord](https://discord.gg/ai16z). Melhor para: compartilhar seus apps e se conectar com a comunidade.

## Contribuidores

<a href="https://github.com/ai16z/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ai16z/eliza" />
</a>

## Histórico de estrelas

[![Gráfico do histórico de estrelas](https://api.star-history.com/svg?repos=ai16z/eliza&type=Date)](https://star-history.com/#ai16z/eliza&Date)
