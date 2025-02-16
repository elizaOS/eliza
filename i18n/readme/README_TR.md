# Eliza 🤖

<div align="center">
  <img src="https://github.com/elizaOS/eliza/blob/develop/docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />
</div>

<div align="center">

📑 [Teknik Rapor](https://arxiv.org/pdf/2501.06781) |  📖 [Dokümantasyon](https://elizaos.github.io/eliza/) | 🎯 [Örnekler](https://github.com/thejoven/awesome-eliza)

</div>

## 🌍 README Çevirileri

[中文说明](i18n/readme/README_CN.md) | [日本語の説明](i18n/readme/README_JA.md) | [한국어 설명](i18n/readme/README_KOR.md) | [Persian](i18n/readme/README_FA.md) | [Français](i18n/readme/README_FR.md) | [Português](i18n/readme/README_PTBR.md) | [Türkçe](i18n/readme/README_TR.md) | [Русский](i18n/readme/README_RU.md) | [Español](i18n/readme/README_ES.md) | [Italiano](i18n/readme/README_IT.md) | [ไทย](i18n/readme/README_TH.md) | [Deutsch](i18n/readme/README_DE.md) | [Tiếng Việt](i18n/readme/README_VI.md) | [עִברִית](i18n/readme/README_HE.md) | [Tagalog](i18n/readme/README_TG.md) | [Polski](i18n/readme/README_PL.md) | [Arabic](i18n/readme/README_AR.md) | [Hungarian](i18n/readme/README_HU.md) | [Srpski](i18n/readme/README_RS.md) | [Română](i18n/readme/README_RO.md) | [Nederlands](i18n/readme/README_NL.md) | [Ελληνικά](i18n/readme/README_GR.md)

## 🚩 Genel Bakış

<div align="center">
  <img src="https://github.com/elizaOS/eliza/blob/develop/docs/static/img/eliza_diagram.png" alt="Eliza Diagram" width="100%" />
</div>

## ✨ Özellikler

- 🛠️ Discord, X (Twitter) ve Telegram için tam donanımlı bağlayıcılar
- 🔗 Tüm modelleri destekler (Llama, Grok, OpenAI, Anthropic, Gemini, etc.)
- 👥 Çoklu agent ve oda desteği
- 📚 Belgelerinizi kolayca içe aktarın ve etkileşime geçin
- 💾 Geri alınabilir hafıza ve belge deposu
- 🚀 Kolayca genişletilebilir - Kendi işlemlerinizi ve istemcilerinizi oluşturun
- 📦 Hızlı çalışır!

## Video Tutorials

[AI Agent Dev School](https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL)

## 🎯 Use Cases

- 🤖 Sohbet botları
- 🕵️ Otonom agentlar
- 📈 İş yönetimi
- 🎮 Video oyunu NPC'leri
- 🧠 Trading

## 🚀 Hızlı Başlangıç

### Gereksinimler

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

> **Windows Kullanıcıları** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) kullanmalıdır.

### Başlangıç Şablonunu Kullanın (Önerilir)

```bash
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
pnpm i && pnpm build && pnpm start
```

### Elizayı manual olarak başlar (Sadece ne yaptığınızı biliyorsanız önerilir)

#### Son yayınlanan versiyonu kontrol edin

```bash
# Repositoryi kopyala
git clone https://github.com/elizaos/eliza.git

# Proje hızlı gelişiyor, yani son versiyonu kontrol etmeniz önerilir
git checkout $(git describe --tags --abbrev=0)
# Üstteki komut işe yaramadıysa bunu deneyebilirsin:
# git checkout $(git describe --tags `git rev-list --tags --max-count=1`)
```

#### .env dosyasını düzenleyin

.env.example dosyasını .env olarak kopyalayın ve uygun değerleri doldurun.

```
cp .env.example .env
```

Not: .env opsiyoneldir. Birden fazla farklı agent kullanmayı planlıyorsanız karakterinizi direkt olarak JSON dosyası üzerinden inşa edebilirsiniz

#### Eliza'yı Başlatın

```bash
pnpm i
pnpm build
pnpm start

# Proje hızlı gelişiyor, bazen projeye geri döndüğünüzde projeyi temizlemeniz gerekebilir
pnpm clean
```

### Tarayıcı Üzerinden Etkileşime Geçin

Agent çalıştığında, sonunda "pnpm start:client " komutunu çalıştırmanız gerektiğini belirten bir mesaj görmelisiniz.

Başka bir terminal açın, aynı dizine gidin, aşağıdaki komutu çalıştırın ve ardından agentla sohbet etmek için URL'yi takip edin..

```bash
pnpm start:client
```

Ardından Eliza'nızı nasıl özelleştireceğinizi öğrenmek için [Dokümantasyon](https://elizaos.github.io/eliza/)'u okuyun .

---

### Eliza'yı Otomatik Olarak Başlatın

Başlatma komutu Eliza'yı otomatik olarak kurup başlatmanızı sağlar:

```bash
sh scripts/start.sh
```

Başlatma komutunu kullanma, karakter yönetimi ve sorun giderme dahil ayrıntılı talimatlar için [Başlatma Komutu Kılavuzu](./docs/docs/guides/start-script.md)'nu kullanın.

> **Not**:  Başlatma komutu tüm bağımlılıkları, ortam kurulumunu ve karakter yönetimini otomatik olarak halleder..

---

### Karakteri Güncelle

1. Varsayılan karakteri değiştirmek için `packages/core/src/defaultCharacter.ts` dosyasını açın. Yorumu kaldırın ve düzenleyin.

2. Özel karakterleri yükle:
    - `pnpm start --characters="path/to/your/character.json"` komutunu kullan
    - Aynı anda birden fazla karakter dosyası yüklenebilir
3. X (Twitter) ile bağlantı kurun
    - Karakter dosyasındaki `"clients": []` ifadesini `"clients": ["twitter"]` olarak değiştirin

---

#### Ek Gereksinimler

Sharp'ı yüklemeniz gerekebilir. Başlatırken bir hata görürseniz, aşağıdaki komutla yüklemeyi deneyin:

```
pnpm install --include=optional sharp
```

---

### Gitpod ile Eliza'yı Başlatın

[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/elizaos/eliza/tree/main)

---

### Tek Tıkla Eliza'yı Başlatın 

Eliza'yı tek tıkla başlatmak için [Fleek](https://fleek.xyz/eliza/) kullanın. Bu, Eliza'yı geliştiriciler dışındaki kişilere açar ve agentınızı oluşturmak için aşağıdaki seçenekleri sunar:
1. Bir şemyala başlama
2. Karakter dosyasını sıfırdan oluşturma
3. Önceden hazırlanmış karakter dosyasını yükleyin

Başlamak için [buraya](https://fleek.xyz/eliza/) tıkla!

---

### Topluluk ve İletişim

- Karşılaştığınız hatalar ve yapmak istediğiniz öneriler için [GitHub Issues](https://github.com/elizaos/eliza/issues)'u kullanabilirsiniz.
- Uygulamalarınızı paylaşmak ve toplulukla vakit geçirmek için [Discord](https://discord.gg/ai16z)'u kullanabilirsiniz.

## Atıf

Artık Eliza OS hakkında bir [makale](https://arxiv.org/pdf/2501.06781) var ve bu makaleye şu şekilde atıfta bulunabilirsiniz:
```bibtex
@article{walters2025eliza,
  title={Eliza: A Web3 friendly AI Agent Operating System},
  author={Walters, Shaw and Gao, Sam and Nerd, Shakker and Da, Feng and Williams, Warren and Meng, Ting-Chien and Han, Hunter and He, Frank and Zhang, Allen and Wu, Ming and others},
  journal={arXiv preprint arXiv:2501.06781},
  year={2025}
}
```

## Katkıda Bulunanlar

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" alt="Eliza project contributors" />
</a>


## Yıldız Geçmişi

[![Star History Chart](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)
