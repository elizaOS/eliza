const form = document.querySelector("#waitlist-form");
const status = document.querySelector("#form-status");
const button = form?.querySelector("button");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const email = String(data.get("email") || "").trim();
  const companyWebsite = String(data.get("companyWebsite") || "");

  status.className = "status";
  if (!email || !form.email.checkValidity()) {
    status.textContent = "Enter a valid email address.";
    status.classList.add("error");
    form.email.focus();
    return;
  }

  button.disabled = true;
  status.textContent = "Joining…";
  try {
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, companyWebsite, source: "eliza.app" }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(result.error || "Could not join right now.");
    form.reset();
    status.textContent = result.alreadyJoined
      ? "You're already on the list."
      : "You're in. We'll be in touch.";
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Could not join right now.";
    status.classList.add("error");
  } finally {
    button.disabled = false;
  }
});
