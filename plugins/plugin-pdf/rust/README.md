# elizaOS PDF Plugin (Rust)

PDF reading and text extraction for elizaOS agents.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-pdf = "1.0"
```

## Usage

```rust
use elizaos_plugin_pdf::{PdfClient, PdfExtractionOptions};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = PdfClient::new();

    // Extract text from PDF bytes
    let pdf_bytes = std::fs::read("document.pdf")?;
    let text = client.extract_text(&pdf_bytes, None).await?;
    println!("Text: {}", text);

    // Extract with options
    let options = PdfExtractionOptions::new()
        .start_page(1)
        .end_page(5);
    let text = client.extract_text(&pdf_bytes, Some(options)).await?;

    // Get full document info
    let info = client.get_document_info(&pdf_bytes).await?;
    println!("Pages: {}", info.page_count);
    println!("Title: {:?}", info.metadata.title);

    Ok(())
}
```

## Features

- Extract text from PDF files
- Get document metadata (title, author, etc.)
- Page-by-page text extraction
- Configurable text cleaning
- Async/await support
- Type-safe with strong error handling

## License

MIT



