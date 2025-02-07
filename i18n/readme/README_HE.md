<div align="rtl" dir="rtl">

# אלייזה 🤖

<div align="center">
  <img src="./docs/static/img/eliza_banner.jpg" alt="אלייזה באנר" width="100%" />
</div>

<div align="center">

📖 [תיעוד](https://elizaos.github.io/eliza/) | 🎯 [דוגמאות](https://github.com/thejoven/awesome-eliza)

</div>

<div align="center">

[中文说明](https://github.com/elizaos/Elisa/blob/main/README_CN.md) | [日本語の説明](https://github.com/elizaos/Elisa/blob/main/README_JA.md) | [한국어 설명](https://github.com/elizaos/Elisa/blob/main/README_KOR.md) | [Français](https://github.com/elizaos/Elisa/blob/main/README_FR.md) | [Português](https://github.com/elizaos/Elisa/blob/main/README_PTBR.md) | [Türkçe](TR.md) | [Русский](https://github.com/elizaos/Elisa/blob/main/README_RU.md) | [Español](https://github.com/elizaos/Elisa/blob/main/README_ES.md) | [Italiano](https://github.com/elizaos/Elisa/blob/main/README_IT.md) | [ไทย](https://github.com/elizaos/Elisa/blob/main/README_TH.md) | [Deutsch](https://github.com/elizaos/Elisa/blob/main/README_DE.md) | [עִברִית](https://github.com/elizaos/Elisa/blob/main/README_HE.md)

</div>

<div dir="rtl" align="right">

## ✨ תכונות

- 🛠️ מחברים מלאים לדיסקורד, טוויטר וטלגרם
- 🔗 תמיכה בכל מודל (Llama, Grok, OpenAI, Anthropic, וכו')
- 👥 תמיכה בריבוי סוכנים וחדרים
- 📚 קל לשלב ולהשתמש במסמכים שלך
- 💾 זיכרון ומאגר מסמכים הניתנים לשליפה
- 🚀 ניתן להרחבה רבה - יצירת פעולות ולקוחות משלך
- ☁️ תומך בהרבה מודלים (local Llama, OpenAI, Anthropic, Groq ,
  וכו')
- 📦 פשוט עובד!

</div>

## 🎯 מקרי שימוש

<div align="right">
-   🤖 צ'טבוטים
</div>
<div align="right">
-   🕵️ סוכנים אוטונומיים
</div>
<div align="right">
-   📈 טיפול בתהליכים עסקיים
</div>
<div align="right">
-   🎮 במשחקי וידאו (NPCs)
</div>
<div align="right">
-   🧠 מסחר
</div>

## 🚀 התחלה מהירה

<div align="right">

### דרישות מוקדמות

[Python 2.7+](https://www.python.org/downloads/) -

[Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) -

[bun](https://bun.io/installation) -

> **הערה למשתמשי Windows:** נדרש [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual)

</div>

### שימוש ב-Starter (מומלץ)

<div align="right" dir="ltr">

```
git clone https://github.com/elizaos/eliza-starter.git

cp .env.example .env

bun i && bun start
```

</div>

לאחר מכן קרא את [התיעוד](https://elizaos.github.io/eliza/) כדי ללמוד כיצד להתאים את אלייזה.

### התחלה ידנית של אלייזה (מומלץ רק למי שיודע מה הוא עושה)

<div align="right">

```
# שכפול המאגר
git clone https://github.com/elizaos/eliza.git

# מעבר לגרסה האחרונה
git checkout $(git describe --tags --abbrev=0)
```

</div>

### התחלת אלייזה עם Gitpod

<div align="right">

[![פתח ב-Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/elizaos/eliza/tree/main)

</div>

### עריכת קובץ .env

<div align="right">

העתק את .env.example ל-.env ומלא את הערכים המתאימים.

```
cp .env.example .env
```

</div>

הערה: .env הוא אופציונלי. אם אתם מתכננים להפעיל מספר סוכנים נפרדים, ניתן להעביר סודות דרך JSON הדמות.

### התחלה אוטומטית של אלייזה

פעולה זו תפעיל הכל כדי להגדיר את הפרויקט ולהתחיל את הבוט עם הדמות המובנית.

<div align="right">

```bash
sh scripts/start.sh
```

</div>

### עריכת קובץ הדמות

1. פתח את `agent/src/character.ts` כדי לשנות את דמות ברירת המחדל. בטל הערה וערוך.

2. לטעינת דמויות מותאמות אישית:

    - השתמש ב-`bun start --characters="path/to/your/character.json"`
    - ניתן לטעון מספר קבצי דמויות בו זמנית.

3. התחבר עם X (טוויטר):
    - שנה `"clients": []` ל-`"clients": ["twitter"]` בקובץ הדמות כדי להתחבר ל-X.

### התחלה ידנית של אלייזה

<div align="right">

```bash
bun i
bun run build
bun start

# לעיתים צריך לנקות את הפרויקט אם חוזרים אליו לאחר זמן
bun clean
```

</div>

#### דרישות נוספות

ייתכן שתצטרך להתקין את Sharp. אם אתה רואה שגיאה בעת ההפעלה, נסה להתקין עם הפקודה הבאה:

```
bun install --include=optional sharp
```

### קהילה ויצירת קשר

<div align="right">

[GitHub Issues](https://github.com/elizaos/eliza/issues) מתאים ביותר עבור: באגים ופרופוזיציות לתכונות -

[Discord](https://discord.gg/ai16z) מתאים ביותר עבור: שיתוף היישומים שלך והשתתפות בקהילה -

</div>

## תורמים

<!-- <div align="right"> -->

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" />
</a>

<!-- </div> -->

## היסטוריית כוכבים

[![תרשים היסטוריית כוכבים](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)

</div>
