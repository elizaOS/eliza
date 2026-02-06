describe("Item interactions", () => {
  beforeEach(() => {
    cy.viewport(1000, 600);
    cy.intercept(
      {
        method: "GET",
        url: "/airboardgame/store/game*",
      },
      // eslint-disable-next-line quotes
      "[]"
    );
    cy.visit("/");
    cy.contains("0 Test game", { timeout: 10000 })
      .parent()
      .find(".img-wrapper")
      .click();
    // Wait board loading
    cy.get(".board-pane", { timeout: 10000 }).should(
      "have.css",
      "transform",
      "matrix(0.24, 0, 0, 0.24, -5596.48, -5808.48)"
    );
    cy.get(".item")
      .first()
      .children()
      .first()
      .should("have.css", "transform", "none");
  });

  it("should move item", () => {
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .parent()
      .should("have.css", "transform", "matrix(1, 0, 0, 1, 420, 400)");

    // Select card
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .click(500, 500, { force: true });

    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .trigger("pointerdown", {
        buttons: 1,
        clientX: 430,
        clientY: 430,
        force: true,
        pointerId: 1,
      });

    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .trigger("pointermove", {
        buttons: 1,
        clientX: 530,
        clientY: 530,
        force: true,
        pointerId: 1,
      })
      .trigger("pointerup", {
        force: true,
        pointerId: 1,
      });

    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .parent()
      .should("have.css", "transform", "matrix(1, 0, 0, 1, 837, 816.5)");
  });

  it("should flip item", () => {
    // Check before
    cy.get("img[src='/game_assets/JC.jpg']");
    cy.get("img[src='/game_assets/Red_back.jpg']").should("not.exist");
    // Select card
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .click(500, 500, { force: true });

    cy.get('[title = "Reveal/Hide (f)"]').click({ force: true });

    // Check after
    cy.get("img[src='/game_assets/JC.jpg']").should("not.exist");
    cy.get("img[src='/game_assets/Red_back.jpg']");
  });

  it("should tap item", () => {
    // Check before
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .should("have.css", "transform", "matrix(1, 0, 0, 1, 0, 0)");

    // Select card
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .click(500, 500, { force: true });

    cy.get('[title = "Tap/Untap (t)"]').click({ force: true });

    // Check after
    cy.get("img[src='/game_assets/JC.jpg']")
      .parents(".item")
      .should("have.css", "transform", "matrix(0, 1, -1, 0, 0, 0)");
  });
});
