# Words

What a page can say, for the specs of any page that says it.

## Story: Say something

> As a visitor, I want the page to say hello to me by name.

### A page says hello to a name

```quint
type Said = Hello({ to: str })

pure def hello(name: str): Said = Hello({ to: name })
```
