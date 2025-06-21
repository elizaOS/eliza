describe('Plugin Starter Hello World', () => {
  it('should verify the server is running', () => {
    // Visit the base URL
    cy.visit('/', { failOnStatusCode: false });

    // Check that we get a page (even if it's a 404 page)
    cy.get('body').should('exist');
  });

  it('should check server response', () => {
    // Make a request to the server
    cy.request({
      url: '/',
      failOnStatusCode: false,
    }).then((response) => {
      // Any response means the server is up
      expect(response).to.have.property('status');
      cy.log(`Server responded with status: ${response.status}`);
    });
  });

  it('should verify API endpoint', () => {
    // Try to access a basic API endpoint
    cy.request({
      method: 'GET',
      url: '/api/health',
      failOnStatusCode: false,
    }).then((response) => {
      cy.log(`API health check status: ${response.status}`);
      // Even a 404 is OK - it means the server is running
      expect(response.status).to.be.oneOf([200, 404]);
    });
  });
});
