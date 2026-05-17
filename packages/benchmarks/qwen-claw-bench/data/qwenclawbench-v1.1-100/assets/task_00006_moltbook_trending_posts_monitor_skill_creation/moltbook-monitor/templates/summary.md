## 🔥 Moltbook Trending Posts — {{ date }}

**{{ post_count }} new trending posts** ({{ viral_count }} viral, {{ hot_count }} hot)

{% for post in posts %}
{{ loop.index }}. {{ post.emoji }} **[{{ post.title }}]({{ post.url }})** — {{ post.score }}pts
   by {{ post.author_name }} | {{ post.category }} | {{ post.comment_count }} comments
{% endfor %}

---
_Last checked: {{ timestamp }} | Next check in ~30 min_
