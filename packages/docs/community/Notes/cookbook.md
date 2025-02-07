# Cookbook

- Clone repo: https://github.com/elizaos/eliza

This command will get last month of contributions in a pretty JSON format

```bash!
git log --since="1 month ago" --date=short --pretty=format:'{"commit": "%H", "author": "%an", "date": "%ad", "message": "%s"}' | sed '1s/^/[\n/; $!s/$/,/; $s/$/\n]/' > 1month.json
```

Sample output JSON file:

```json!
[
  {
    "commit": "91239964e205386f9c08fb69f5daf5a4ffe04d71",
    "author": "Loaf",
    "date": "2024-11-22",
    "message": "Merge pull request #472 from tarrencev/main"
  },
  {
    "commit": "8450877832e91094a833e348de4c660895e21a2a",
    "author": "Bruno Galego",
    "date": "2024-11-21",
    "message": "Merge pull request #476 from haeunchin/document-update-for-twitter-cookie"
  },
  {
    "commit": "0d753341437998339b7f100adf80f6866e209c42",
    "author": "Tarrence van As",
    "date": "2024-11-20",
    "message": "Improve knowledge embeddings"
  },
```

You can output the messages of what each contributor did like this:

```bash
jq '.[] | select(.author == "Loaf") | .message' 1month.json
```

Which returns output that looks like this:

```
"Merge pull request #472 from tarrencev/main"
"Merge pull request #482 from bmgalego/improvements"
"Merge pull request #446 from darwintree/patch-2"
"Merge pull request #466 from elizaos/env"
"Merge pull request #475 from elizaos/fix/ci"
"Merge pull request #378 from bmgalego/cache-manager"
"Merge pull request #456 from tarrencev/githubclient"
"Merge pull request #460 from martincik/fix/fix-up-the-postgresql-schema"
"Merge pull request #462 from coffeeorgreentea/create-eliza-app"
```

Or to process into something like a CSV file with dates:

```bash
jq -r '.[] | select(.author == "Loaf") | [.date, .message] | @csv' 1month.json
```

Output:

```
"2024-11-22","Merge pull request #472 from tarrencev/main"
"2024-11-21","Merge pull request #482 from bmgalego/improvements"
"2024-11-21","Merge pull request #446 from darwintree/patch-2"
"2024-11-21","Merge pull request #466 from elizaos/env"
"2024-11-21","Merge pull request #475 from elizaos/fix/ci"
"2024-11-21","Merge pull request #378 from bmgalego/cache-manager"
"2024-11-21","Merge pull request #456 from tarrencev/githubclient"
"2024-11-21","Merge pull request #460 from martincik/fix/fix-up-the-postgresql-schema"
"2024-11-21","Merge pull request #462 from coffeeorgreentea/create-eliza-app"
"2024-11-20","Merge pull request #449 from elizaos/readme"
"2024-11-20","Merge pull request #447 from elizaos/fix/voice-perms"
"2024-11-20","Merge pull request #444 from elizaos/unrug-fix"
...
```

### CSV of Commits

```bash!
jq -r 'sort_by(.author) | .[] | [.commit, .author, .date, .message] | @csv' 1month.json
```

Will produce output like this:

```
"03cd5ccc2dd20af42535c3dd47c90f65b0726144","tsubasakong","2024-11-15","clean log"
"3c2bedbfae10e2bd9f762b85f5f9488fb2510176","tsubasakong","2024-11-15","clean"
"3ab32a97f8c2d1dc1a4425a2dc4b570c8be5e30f","twilwa","2024-11-20","Merge pull request #470 from odilitime/patch-3"
"3f2cc7d693d1cc3e2625e2e385d8c8b540ca2652","twilwa","2024-11-20","Merge pull request #468 from odilitime/patch-2"
"a2e0954a5871eaace15dc9197fd7457b1b62064e","twilwa","2024-11-17","Merge pull request #382 from elizaos/add-client"
"e0444cbde2cd46584b0f1e1ef9501a09382dd021","twilwa","2024-11-17","Merge branch 'main' into add-client"
"4b1caa00b77b5eb23e15d3adc3774fd4d6062fe2","twilwa","2024-11-16","Merge pull request #364 from elizaos/new_docs"
"1422736a4c0f238c09c9c769dfa1926fa1a23039","twilwa","2024-11-12","Merge pull request #273 from elizaos/docs"
"0e7722d643664681c2403f9e6d88f7b212105505","twilwa","2024-11-12","replace .env.example"
"34fd76e6b4e6661c86eac1fc879cf21d76208c3b","twilwa","2024-11-12","lint with prettier"
```
