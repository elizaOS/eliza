use anyhow::{Context, Result};
use clap::Args;
use colored::*;
use std::fs;
use std::path::Path;
use std::process::Command as ProcessCommand;

#[derive(Debug, Args)]
pub struct InitCommand {
    /// Name of the workflow project to create
    #[arg(default_value = "my-workflow")]
    name: String,

    /// Skip npm install after scaffolding
    #[arg(long)]
    skip_install: bool,

    /// Use bun instead of npm for installation
    #[arg(long)]
    use_bun: bool,
}

impl InitCommand {
    pub async fn execute(&self) -> Result<()> {
        let project_path = Path::new(&self.name);

        // Check if directory already exists
        if project_path.exists() {
            return Err(anyhow::anyhow!(
                "Directory '{}' already exists. Please choose a different name or remove the existing directory.",
                self.name
            ));
        }

        println!("{}", "🚀 Creating new ComputerUse workflow...".bold().cyan());
        println!();

        // Create directory structure
        self.create_directory_structure(project_path)?;

        // Create all template files
        self.create_package_json(project_path)?;
        self.create_tsconfig(project_path)?;
        self.create_main_workflow(project_path)?;
        self.create_step_one(project_path)?;
        self.create_step_two(project_path)?;
        self.create_readme(project_path)?;
        self.create_gitignore(project_path)?;

        println!("  {} Created project structure", "✓".green());

        // Install dependencies
        if !self.skip_install {
            self.install_dependencies(project_path)?;
        }

        // Print success message
        self.print_success_message();

        Ok(())
    }

    fn create_directory_structure(&self, project_path: &Path) -> Result<()> {
        fs::create_dir_all(project_path.join("src/steps"))
            .context("Failed to create src/steps directory")?;
        Ok(())
    }

    fn create_package_json(&self, project_path: &Path) -> Result<()> {
        let package_json = format!(
            r#"{{
  "name": "{}",
  "version": "1.0.0",
  "description": "ComputerUse workflow automation",
  "main": "src/computeruse.ts",
  "scripts": {{
    "build": "tsc --noEmit"
  }},
  "dependencies": {{
    "@mediar-ai/workflow": "latest"
  }},
  "devDependencies": {{
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }}
}}
"#,
            self.name
        );

        fs::write(project_path.join("package.json"), package_json)
            .context("Failed to create package.json")?;
        Ok(())
    }

    fn create_tsconfig(&self, project_path: &Path) -> Result<()> {
        let tsconfig = r#"{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
"#;

        fs::write(project_path.join("tsconfig.json"), tsconfig)
            .context("Failed to create tsconfig.json")?;
        Ok(())
    }

    fn create_main_workflow(&self, project_path: &Path) -> Result<()> {
        let workflow = r#"import { createWorkflow, z } from "@mediar-ai/workflow";
import { stepOne } from "./steps/01-step-one";
import { stepTwo } from "./steps/02-step-two";

export default createWorkflow({
  // use package.json to set name, description, and version
  input: z.object({
    // Add your input variables here
    alreadyDone: z.boolean().default(false),  // exits early with success()
    skipStepTwo: z.boolean().default(false),  // jumps with next()
  }).optional(),
  trigger: {
    type: 'cron',
    schedule: '*/5 * * * *', // Every 5 minutes
    enabled: false, // Set to true to enable scheduling
  },
  steps: [
    stepOne,
    stepTwo,
  ],
  onSuccess: async ({ context }) => {
    // Set context.data to return results to MCP/CLI
    context.data = { completed: true, state: context.state };
  },
  onError: async ({ error }: { error: Error }) => {
    console.error("Workflow failed:", error.message);
  },
});
"#;

        fs::write(project_path.join("src/computeruse.ts"), workflow)
            .context("Failed to create src/computeruse.ts")?;
        Ok(())
    }

    fn create_step_one(&self, project_path: &Path) -> Result<()> {
        let step = r#"import { createStep, next, success } from "@mediar-ai/workflow";

export const stepOne = createStep({
  id: "step_one",
  name: "Open Application and Login",
  execute: async ({ desktop, input, context }) => {
    // BUSINESS CONTEXT:
    // This step launches the target application and performs initial setup.
    // It handles cases where work is already done (skips execution).
    //
    // WHY THIS EXISTS:
    // Users need automated login to avoid manual repetitive work.
    // The alreadyDone check prevents duplicate processing.

    // Skip if already processed (e.g., invoice already submitted today)
    if (input?.alreadyDone) {
      return success({
        message: "Nothing to do - already completed",
        data: { skipped: true },
      });
    }

    // Track progress for subsequent steps
    context.setState({ stepOneCompleted: true });

    // Skip step two if requested (e.g., user only wants partial run)
    if (input?.skipStepTwo) {
      console.log("Skipping step two as requested");
      return next("step_two");
    }

    // TODO: Open your application
    // desktop.openApplication("notepad");
    // await desktop.delay(1500);

    // TODO: Click login button or perform initial action
    // const btn = await desktop.locator("role:Button && name:Login").first(2000);
    // await btn.click();

    console.log("Step one completed");
  },
});
"#;

        fs::write(project_path.join("src/steps/01-step-one.ts"), step)
            .context("Failed to create src/steps/01-step-one.ts")?;
        Ok(())
    }

    fn create_step_two(&self, project_path: &Path) -> Result<()> {
        let step = r#"import { createStep } from "@mediar-ai/workflow";

export const stepTwo = createStep({
  id: "step_two",
  name: "Process Data and Submit",
  execute: async ({ desktop, context }) => {
    // BUSINESS CONTEXT:
    // This step performs the main business action after login.
    // It uses data from step one to complete the workflow.
    //
    // WHY THIS EXISTS:
    // The actual work happens here - filling forms, clicking buttons,
    // extracting data, or submitting information.
    //
    // DEPENDENCIES:
    // - Requires stepOneCompleted=true from previous step

    // Verify previous step completed successfully
    if (!context.state.stepOneCompleted) {
      throw new Error("Step one must complete before step two");
    }

    // TODO: Fill in form fields with your data
    // await desktop.locator("role:TextBox && name:Invoice Number").fill("INV-001");

    // TODO: Click submit or perform main action
    // await desktop.locator("role:Button && name:Submit").click();

    // Mark completion for workflow summary
    context.setState(prev => ({ ...prev, stepTwoCompleted: true }));

    console.log("Step two completed - workflow finished");
  },
});
"#;

        fs::write(project_path.join("src/steps/02-step-two.ts"), step)
            .context("Failed to create src/steps/02-step-two.ts")?;
        Ok(())
    }

    fn create_readme(&self, project_path: &Path) -> Result<()> {
        let readme = format!(
            r#"# {}

## What does this workflow do?

Describe what this workflow accomplishes in plain language. For example:

- Opens an application
- Fills out a form with data
- Clicks buttons and navigates through screens
- Extracts information and saves results

## Inputs

| Name | Type | Default | Description |
|------|------|---------|-------------|
| alreadyDone | boolean | false | Skip the workflow if already completed |
| skipStepTwo | boolean | false | Skip the second step |

## Steps

### Step 1: Open Application and Login
The first step that runs. It can:
- Exit early if work is already done
- Skip to other steps based on conditions

### Step 2: Process Data and Submit
The second step that processes data from Step One.

## Folder Structure

```
src/
  computeruse.ts      # Main workflow definition
  steps/
    01-step-one.ts   # First step
    02-step-two.ts   # Second step
```

## Comment Conventions

Each step should have comments explaining:

- **BUSINESS CONTEXT**: What the step does in plain language
- **WHY THIS EXISTS**: The business reason for this step

Example:
```typescript
// BUSINESS CONTEXT: Submit the invoice form
// WHY: Finance team needs invoices submitted before 9am daily
await desktop.locator("role:Button && name:Submit").click();
```

## How to run

```bash
computeruse workflow run src/computeruse.ts
```
"#,
            self.name
        );

        fs::write(project_path.join("README.md"), readme).context("Failed to create README.md")?;
        Ok(())
    }

    fn create_gitignore(&self, project_path: &Path) -> Result<()> {
        let gitignore = r#"node_modules/
dist/
*.log
.DS_Store
state.json
"#;

        fs::write(project_path.join(".gitignore"), gitignore)
            .context("Failed to create .gitignore")?;
        Ok(())
    }

    fn install_dependencies(&self, project_path: &Path) -> Result<()> {
        println!();
        println!("  {} Installing dependencies...", "📦".cyan());

        let (cmd, args) = if self.use_bun {
            ("bun", vec!["install"])
        } else {
            ("npm", vec!["install"])
        };

        let result = ProcessCommand::new(cmd)
            .args(&args)
            .current_dir(project_path)
            .output();

        match result {
            Ok(output) if output.status.success() => {
                println!("  {} Dependencies installed", "✓".green());
                Ok(())
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                println!(
                    "  {} Failed to install dependencies: {}",
                    "⚠".yellow(),
                    stderr
                );
                println!("  Run `cd {} && npm install` manually", self.name);
                Ok(())
            }
            Err(e) => {
                println!("  {} Could not run {}: {}", "⚠".yellow(), cmd, e);
                println!("  Run `cd {} && npm install` manually", self.name);
                Ok(())
            }
        }
    }

    fn print_success_message(&self) {
        println!();
        println!("{}", "✅ Workflow created successfully!".bold().green());
        println!();
        println!("Next steps:");
        println!("  1. cd {}", self.name.cyan());
        println!("  2. npm install");
        println!("  3. Edit {} to add your steps", "src/steps/".cyan());
        println!("  4. Run your workflow:");
        println!(
            "     {}",
            format!("computeruse mcp run {}/src/computeruse.ts", self.name).cyan()
        );
        println!();
        println!(
            "Documentation: {}",
            "https://github.com/mediar-ai/computeruse".underline()
        );
    }
}
