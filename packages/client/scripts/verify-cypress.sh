#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🔍 Verifying Cypress Installation${NC}"
echo "=================================="

# Check if Cypress binary is installed
bunx cypress verify > /dev/null 2>&1
VERIFY_EXIT_CODE=$?

if [ $VERIFY_EXIT_CODE -ne 0 ]; then
  echo -e "${YELLOW}📥 Cypress binary not found${NC}"
  echo -e "${YELLOW}Installing Cypress binary...${NC}"
  
  # Install Cypress binary
  bunx cypress install
  INSTALL_EXIT_CODE=$?
  
  if [ $INSTALL_EXIT_CODE -ne 0 ]; then
    echo -e "${RED}❌ Failed to install Cypress binary${NC}"
    exit 1
  else
    echo -e "${GREEN}✅ Cypress binary installed successfully${NC}"
    
    # Verify installation
    bunx cypress verify
    if [ $? -ne 0 ]; then
      echo -e "${RED}❌ Cypress binary verification failed after installation${NC}"
      exit 1
    else
      echo -e "${GREEN}✅ Cypress binary verified successfully${NC}"
    fi
  fi
else
  echo -e "${GREEN}✅ Cypress binary is already installed${NC}"
  bunx cypress version
fi

echo -e "\n${GREEN}✅ Cypress is ready to use!${NC}"
exit 0 