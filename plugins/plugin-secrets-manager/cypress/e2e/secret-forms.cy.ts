/// <reference types="cypress" />

describe('Secret Forms E2E Tests', () => {
  const baseUrl = 'http://localhost:10000'; // Test server URL
  let formUrl: string;
  let sessionId: string;

  // Helper to create a test form
  const createTestForm = () => {
    // This would normally be done through the API
    // For testing, we'll assume the form is already created
    // and we have the URL
    cy.task('createSecretForm', {
      secrets: [
        {
          key: 'API_KEY',
          config: {
            type: 'api_key',
            description: 'Test API Key',
            required: true,
          },
        },
      ],
      title: 'Test Secret Form',
      description: 'Please enter your API key for testing',
    }).then((result: any) => {
      formUrl = result.url;
      sessionId = result.sessionId;
    });
  };

  beforeEach(() => {
    // Create a fresh form for each test
    createTestForm();
  });

  afterEach(() => {
    // Clean up the form session
    cy.task('closeSecretForm', sessionId);
  });

  describe('Form Display', () => {
    it('should display the form with correct title and description', () => {
      cy.visit(formUrl);

      // Check title
      cy.get('h1').should('contain', 'Test Secret Form');

      // Check description
      cy.get('p').should('contain', 'Please enter your API key for testing');

      // Check form field
      cy.get('label').should('contain', 'Test API Key');
      cy.get('#API_KEY').should('exist');
      cy.get('#API_KEY').should('have.attr', 'type', 'password');
      cy.get('#API_KEY').should('have.attr', 'required');
    });

    it('should display countdown timer', () => {
      cy.visit(formUrl);

      // Check countdown exists
      cy.get('#countdown').should('exist');

      // Check countdown is updating
      cy.get('#countdown').then(($countdown) => {
        const initialText = $countdown.text();
        cy.wait(2000);
        cy.get('#countdown').should('not.have.text', initialText);
      });
    });

    it('should show required indicator for required fields', () => {
      cy.visit(formUrl);

      // Check for red asterisk
      cy.get('label').contains('Test API Key').find('span.text-red-500').should('contain', '*');
    });

    it('should apply dark mode classes', () => {
      cy.visit(formUrl);

      // Check for dark mode classes
      cy.get('body').should('have.class', 'dark:bg-gray-900');
      cy.get('.form-container').should('have.class', 'dark:bg-gray-800');
    });
  });

  describe('Form Submission', () => {
    it('should submit form successfully with valid data', () => {
      cy.visit(formUrl);

      // Fill in the form
      cy.get('#API_KEY').type('sk-test-12345678901234567890');

      // Submit the form
      cy.get('button[type="submit"]').click();

      // Check loading state
      cy.get('button[type="submit"]').should('be.disabled');
      cy.get('button[type="submit"]').should('contain', 'Submitting...');

      // Check success message
      cy.get('#successMessage').should('be.visible');
      cy.get('#successMessage').should(
        'contain',
        'Thank you! Your information has been securely received.'
      );

      // Check form is hidden
      cy.get('#secretForm').should('not.be.visible');

      // Should redirect after 3 seconds
      cy.wait(3500);
      cy.url().should('eq', 'about:blank');
    });

    it('should show validation error for empty required field', () => {
      cy.visit(formUrl);

      // Try to submit without filling the field
      cy.get('button[type="submit"]').click();

      // Browser should show validation message
      cy.get('#API_KEY:invalid').should('exist');

      // Form should not be submitted
      cy.get('#successMessage').should('not.be.visible');
    });

    it('should show error message on server error', () => {
      // Mock server error
      cy.intercept('POST', `/api/form/${sessionId}/submit`, {
        statusCode: 500,
        body: { error: 'Internal server error' },
      }).as('submitError');

      cy.visit(formUrl);

      // Fill and submit
      cy.get('#API_KEY').type('sk-test-12345678901234567890');
      cy.get('button[type="submit"]').click();

      cy.wait('@submitError');

      // Check error message
      cy.get('#errorMessage').should('be.visible');
      cy.get('#errorMessage').should('contain', 'Internal server error');

      // Button should be re-enabled
      cy.get('button[type="submit"]').should('not.be.disabled');
      cy.get('button[type="submit"]').should('contain', 'Submit Securely');
    });

    it('should show network error on connection failure', () => {
      // Mock network error
      cy.intercept('POST', `/api/form/${sessionId}/submit`, { forceNetworkError: true }).as(
        'networkError'
      );

      cy.visit(formUrl);

      // Fill and submit
      cy.get('#API_KEY').type('sk-test-12345678901234567890');
      cy.get('button[type="submit"]').click();

      cy.wait('@networkError');

      // Check error message
      cy.get('#errorMessage').should('be.visible');
      cy.get('#errorMessage').should('contain', 'Network error. Please try again.');
    });

    it('should clear form data after successful submission', () => {
      cy.visit(formUrl);

      // Fill the form
      const testValue = 'sk-test-12345678901234567890';
      cy.get('#API_KEY').type(testValue);

      // Submit
      cy.get('button[type="submit"]').click();

      // Wait for success
      cy.get('#successMessage').should('be.visible');

      // Check that the value is not in the DOM anymore
      cy.get('body').should('not.contain', testValue);
    });
  });

  describe('Multiple Field Forms', () => {
    beforeEach(() => {
      // Create a form with multiple fields
      cy.task('createSecretForm', {
        secrets: [
          {
            key: 'OPENAI_KEY',
            config: {
              type: 'api_key',
              description: 'OpenAI API Key',
              required: true,
            },
          },
          {
            key: 'WEBHOOK_URL',
            config: {
              type: 'url',
              description: 'Webhook URL',
              required: true,
            },
          },
          {
            key: 'CONFIG_JSON',
            config: {
              type: 'config',
              description: 'JSON Configuration',
              required: false,
            },
          },
        ],
        title: 'Multi-Field Form',
      }).then((result: any) => {
        formUrl = result.url;
        sessionId = result.sessionId;
      });
    });

    it('should display all fields correctly', () => {
      cy.visit(formUrl);

      // Check all fields exist
      cy.get('#OPENAI_KEY').should('exist').should('have.attr', 'type', 'password');
      cy.get('#WEBHOOK_URL').should('exist').should('have.attr', 'type', 'url');
      cy.get('#CONFIG_JSON').should('exist').should('match', 'textarea');

      // Check required indicators
      cy.get('label').contains('OpenAI API Key').find('span.text-red-500').should('exist');
      cy.get('label').contains('Webhook URL').find('span.text-red-500').should('exist');
      cy.get('label').contains('JSON Configuration').find('span.text-red-500').should('not.exist');
    });

    it('should validate all required fields', () => {
      cy.visit(formUrl);

      // Fill only one required field
      cy.get('#OPENAI_KEY').type('sk-openai-test');

      // Try to submit
      cy.get('button[type="submit"]').click();

      // Should show validation for webhook URL
      cy.get('#WEBHOOK_URL:invalid').should('exist');
    });

    it('should submit all fields successfully', () => {
      cy.visit(formUrl);

      // Fill all fields
      cy.get('#OPENAI_KEY').type('sk-openai-test-123');
      cy.get('#WEBHOOK_URL').type('https://example.com/webhook');
      cy.get('#CONFIG_JSON').type('{"temperature": 0.7}');

      // Submit
      cy.get('button[type="submit"]').click();

      // Check success
      cy.get('#successMessage').should('be.visible');
    });
  });

  describe('Special Field Types', () => {
    it('should handle credit card field with formatting', () => {
      cy.task('createSecretForm', {
        secrets: [
          {
            key: 'CREDIT_CARD',
            config: {
              type: 'creditcard',
              description: 'Credit Card Number',
            },
          },
        ],
        title: 'Credit Card Form',
      }).then((result: any) => {
        cy.visit(result.url);

        // Type credit card number
        cy.get('#CREDIT_CARD').type('4111111111111111');

        // Check formatting (should add spaces)
        cy.get('#CREDIT_CARD').should('have.value', '4111 1111 1111 1111');

        // Check maxlength
        cy.get('#CREDIT_CARD').should('have.attr', 'maxlength', '19');

        // Check pattern
        cy.get('#CREDIT_CARD').should('have.attr', 'pattern', '[0-9\\s]{13,19}');
      });
    });

    it('should handle select dropdown field', () => {
      cy.task('createSecretForm', {
        secrets: [
          {
            key: 'ENVIRONMENT',
            config: {
              type: 'select',
              description: 'Environment',
            },
            field: {
              options: [
                { label: 'Development', value: 'dev' },
                { label: 'Staging', value: 'staging' },
                { label: 'Production', value: 'prod' },
              ],
            },
          },
        ],
        title: 'Environment Selection',
      }).then((result: any) => {
        cy.visit(result.url);

        // Check select exists with options
        cy.get('#ENVIRONMENT').should('exist');
        cy.get('#ENVIRONMENT option').should('have.length', 4); // Including "Choose..."

        // Select an option
        cy.get('#ENVIRONMENT').select('staging');
        cy.get('#ENVIRONMENT').should('have.value', 'staging');
      });
    });

    it('should handle textarea with custom rows', () => {
      cy.task('createSecretForm', {
        secrets: [
          {
            key: 'PRIVATE_KEY',
            config: {
              type: 'textarea',
              description: 'Private Key',
            },
            field: {
              rows: 10,
            },
          },
        ],
        title: 'Private Key Form',
      }).then((result: any) => {
        cy.visit(result.url);

        // Check textarea exists with correct rows
        cy.get('#PRIVATE_KEY').should('exist');
        cy.get('#PRIVATE_KEY').should('have.attr', 'rows', '10');
        cy.get('#PRIVATE_KEY').should('have.class', 'font-mono');
      });
    });
  });

  describe('Form Expiration', () => {
    it('should disable form when expired', () => {
      // Create form with very short expiration
      cy.task('createSecretForm', {
        secrets: [
          {
            key: 'TEST_KEY',
            config: { type: 'secret' },
          },
        ],
        title: 'Expiring Form',
        expiresIn: 1000, // 1 second
      }).then((result: any) => {
        cy.visit(result.url);

        // Wait for expiration
        cy.wait(1500);

        // Check form is hidden
        cy.get('#secretForm').should('not.be.visible');
        cy.get('#countdown').should('contain', 'expired');
      });
    });

    it('should show 410 error when accessing expired form', () => {
      // Create and immediately expire a form
      cy.task('createAndExpireForm').then((result: any) => {
        cy.visit(result.url, { failOnStatusCode: false });

        // Should show expired message
        cy.contains('This form has expired or been completed.').should('be.visible');
      });
    });
  });

  describe('Security Tests', () => {
    it('should escape HTML in form fields to prevent XSS', () => {
      cy.task('createSecretForm', {
        secrets: [
          {
            key: 'TEST_KEY',
            config: {
              type: 'secret',
              description: '<script>alert("XSS")</script>',
            },
          },
        ],
        title: '<img src=x onerror=alert("XSS")>',
        description: '"><script>alert("XSS")</script>',
      }).then((result: any) => {
        cy.visit(result.url);

        // Check that script tags are escaped
        cy.get('h1').should('contain', '<img src=x onerror=alert("XSS")>');
        cy.get('h1').should('not.contain', '<img');

        cy.get('p').first().should('contain', '"><script>alert("XSS")</script>');
        cy.get('p').first().should('not.contain', '<script>');

        // Check no alerts are triggered
        cy.on('window:alert', (txt) => {
          throw new Error('XSS alert was triggered: ' + txt);
        });
      });
    });

    it('should use secure headers', () => {
      cy.visit(formUrl);

      // The helmet middleware should set security headers
      // These would be checked in the response headers
      cy.request(formUrl).then((response) => {
        expect(response.headers).to.have.property('x-frame-options');
        expect(response.headers).to.have.property('x-content-type-options');
      });
    });

    it('should not expose sensitive data in URLs', () => {
      cy.visit(formUrl);

      // Fill sensitive data
      cy.get('#API_KEY').type('sk-super-secret-key');
      cy.get('button[type="submit"]').click();

      // Check URL doesn't contain the secret
      cy.url().should('not.contain', 'sk-super-secret-key');

      // Check browser history doesn't contain secrets
      cy.go('back');
      cy.url().should('not.contain', 'sk-super-secret-key');
    });
  });

  describe('Responsive Design', () => {
    const viewports: Cypress.ViewportPreset[] = ['iphone-x', 'ipad-2', 'macbook-15'];

    viewports.forEach((viewport) => {
      it(`should display correctly on ${viewport}`, () => {
        cy.viewport(viewport);
        cy.visit(formUrl);

        // Check form is visible and usable
        cy.get('.form-container').should('be.visible');
        cy.get('#API_KEY').should('be.visible');
        cy.get('button[type="submit"]').should('be.visible');

        // Test interaction
        cy.get('#API_KEY').type('test-key');
        cy.get('button[type="submit"]').click();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels and form structure', () => {
      cy.visit(formUrl);

      // Check labels are properly associated
      cy.get('label[for="API_KEY"]').should('exist');
      cy.get('#API_KEY').should('have.attr', 'id', 'API_KEY');

      // Check form has proper structure
      cy.get('form').should('have.attr', 'id', 'secretForm');

      // Check required fields have required attribute
      cy.get('#API_KEY[required]').should('exist');
    });

    it('should be keyboard navigable', () => {
      cy.visit(formUrl);

      // Tab to the input field
      cy.get('body').tab();
      cy.focused().should('have.attr', 'id', 'API_KEY');

      // Type in the field
      cy.focused().type('test-key');

      // Tab to submit button
      cy.focused().tab();
      cy.focused().should('have.attr', 'type', 'submit');

      // Submit with Enter key
      cy.focused().type('{enter}');

      // Check form was submitted
      cy.get('#successMessage').should('be.visible');
    });
  });
});
