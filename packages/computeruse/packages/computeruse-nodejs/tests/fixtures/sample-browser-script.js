(() => {
  const el = document.querySelector('h1');
  const text = el ? el.textContent : 'no-heading';
  return `fixture:${text}`;
})()


