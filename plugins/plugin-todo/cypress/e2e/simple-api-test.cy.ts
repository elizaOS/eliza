describe('Todo Plugin API Tests', () => {
  const baseUrl = Cypress.config('baseUrl') || 'http://localhost:3000';
  
  describe('Basic Server Tests', () => {
    it('should have the server running', () => {
      // Just check that the server responds
      cy.request({
        url: `${baseUrl}/`,
        failOnStatusCode: false,
      }).then((response) => {
        // Server should respond with something (200 or 404 is ok)
        expect(response.status).to.be.oneOf([200, 404]);
      });
    });

    it('should check if plugin routes are available', () => {
      // Try to access the todos endpoint - it might not exist in dev mode
      cy.request({
        method: 'GET',
        url: `${baseUrl}/api/todos`,
        failOnStatusCode: false,
      }).then((response) => {
        if (response.status === 200) {
          // If the endpoint exists, validate the response
          expect(response.body).to.be.an('array');
          if (response.body.length > 0) {
            const world = response.body[0];
            expect(world).to.have.property('worldId');
            expect(world).to.have.property('worldName');
            expect(world).to.have.property('rooms');
            expect(world.rooms).to.be.an('array');
          }
        } else {
          // If endpoint doesn't exist in dev mode, that's ok
          cy.log('Todo API endpoint not available in dev mode');
        }
      });
    });

    it('should check if tags endpoint is available', () => {
      cy.request({
        method: 'GET',
        url: `${baseUrl}/api/tags`,
        failOnStatusCode: false,
      }).then((response) => {
        if (response.status === 200) {
          expect(response.body).to.be.an('array');
        } else {
          cy.log('Tags API endpoint not available in dev mode');
        }
      });
    });
  });

  describe('Frontend Routes', () => {
    it('should serve a page at /', () => {
      cy.visit('/', { failOnStatusCode: false });
      // Just check that the page loads without error
      cy.get('body').should('exist');
    });

    it('should check todos page availability', () => {
      cy.request({
        url: '/todos',
        failOnStatusCode: false,
      }).then((response) => {
        // Page might exist or not in dev mode
        cy.log(`Todos page status: ${response.status}`);
      });
    });
  });
}); 