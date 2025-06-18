# Node.js Version Conflicts Across Documentation

## 🔥 Priority: Critical

## 📋 Issue Summary

There are conflicting Node.js version requirements across different parts of the documentation and configuration, causing setup failures and user confusion.

## 🐛 Problem Description

### Current State Analysis

**Main README.md claims:**
```markdown
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
```
*File: `/README.md` line 33*

**Documentation states:**
```markdown
- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
```
*File: `/packages/docs/docs/quickstart.md` line 14*

**Actual configuration requires:**
```json
{
  "engines": {
    "node": "23.3.0"
  }
}
```
*File: `/package.json` line 7*

**Docker uses:**
```dockerfile
FROM node:23.3.0-slim
```
*File: `/Dockerfile` line 1*

### Impact

- Users following README.md with Node.js v18-22 will encounter runtime errors
- Inconsistent messaging reduces trust in documentation quality
- Setup failures block new contributors and users

## ✅ Acceptance Criteria

- [ ] All documentation specifies the same Node.js version requirement
- [ ] Version requirement matches the actual `package.json` engines field
- [ ] Clear error messages when wrong Node.js version is detected
- [ ] Installation instructions include version verification steps

## 🔧 Implementation Steps

### 1. Update Root README.md
```markdown
# Change this:
- [Node.js](https://nodejs.org/) (v18 or higher recommended)

# To this:
- [Node.js 23.3.0](https://nodejs.org/) (exact version required)
```

### 2. Update Documentation Files
Update these files to specify Node.js 23.3.0:
- `/packages/docs/docs/intro.md` line 60
- `/packages/docs/docs/quickstart.md` line 14
- `/packages/docs/docs/quickstart.md` line 174

### 3. Add Version Verification
Add to quickstart guide:
```bash
# Verify Node.js version before installation
node --version
# Should output: v23.3.0

# If wrong version, use nvm to install correct version
nvm install 23.3.0
nvm use 23.3.0
```

### 4. Address Package Inconsistencies
Review and align these conflicting configurations:
- `/packages/create-eliza/package.json` requires Node.js >=14.0.0
- Main project requires exactly 23.3.0

## 📝 Files to Update

1. `/README.md` - Line 33, 200
2. `/packages/docs/docs/intro.md` - Line 60  
3. `/packages/docs/docs/quickstart.md` - Line 14, 174
4. `/packages/create-eliza/package.json` - Engines field
5. Add version check to CLI if possible

## 🧪 Testing

- [ ] Verify installation works with Node.js 23.3.0
- [ ] Confirm installation fails gracefully with wrong versions
- [ ] Test all documented installation paths
- [ ] Validate Docker build uses correct Node.js version

## 📚 Related Issues

- Issue #002: Project structure documentation needs updating
- Issue #003: README.md contains other outdated information

## 💡 Additional Context

The Node.js 23.3.0 requirement is likely due to:
- Specific ES module features
- Performance optimizations
- Compatibility with Bun and other tooling

Consider documenting why this exact version is required to help users understand the constraint.

## 📎 Source Code References

- Engine requirement: `/package.json:7`
- Dockerfile: `/Dockerfile:1` 
- NVM config: `/.nvmrc`
- Documentation: `/packages/docs/docs/quickstart.md:14,174`