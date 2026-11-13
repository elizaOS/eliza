// spec/app/index.md, "Only a name that is not empty can be greeted, and a link greets only a name not greeted last"
// A link to the page that greets a name: `?name=Ada`.

/** The address, relative to the page, of a link that greets `name`. */
export const linkTo = (name: string) => `?${new URLSearchParams({ name })}`;

/** The name a link carries, or "" where it carries none. */
export const nameIn = (search: string) => new URLSearchParams(search).get("name") ?? "";
