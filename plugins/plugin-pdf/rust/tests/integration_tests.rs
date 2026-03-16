use elizaos_plugin_pdf::types::{
    PdfConversionResult, PdfDocumentInfo, PdfExtractionOptions, PdfMetadata, PdfPageInfo,
};

#[test]
fn test_extraction_options_default() {
    let options = PdfExtractionOptions::new();
    assert!(options.start_page.is_none());
    assert!(options.end_page.is_none());
    assert!(!options.preserve_whitespace);
    assert!(options.clean_content);
}

#[test]
fn test_extraction_options_builder() {
    let options = PdfExtractionOptions::new()
        .start_page(1)
        .end_page(5)
        .preserve_whitespace(true)
        .clean_content(false);

    assert_eq!(options.start_page, Some(1));
    assert_eq!(options.end_page, Some(5));
    assert!(options.preserve_whitespace);
    assert!(!options.clean_content);
}

#[test]
fn test_conversion_result_success() {
    let result = PdfConversionResult::success("Hello World".to_string(), 1);
    assert!(result.success);
    assert_eq!(result.text, Some("Hello World".to_string()));
    assert_eq!(result.page_count, Some(1));
    assert!(result.error.is_none());
}

#[test]
fn test_conversion_result_failure() {
    let result = PdfConversionResult::failure("Parse error".to_string());
    assert!(!result.success);
    assert!(result.text.is_none());
    assert!(result.page_count.is_none());
    assert_eq!(result.error, Some("Parse error".to_string()));
}

#[test]
fn test_page_info() {
    let page = PdfPageInfo {
        page_number: 1,
        width: 612.0,
        height: 792.0,
        text: "Page content".to_string(),
    };
    assert_eq!(page.page_number, 1);
    assert_eq!(page.width, 612.0);
    assert_eq!(page.height, 792.0);
}

#[test]
fn test_metadata_default() {
    let metadata = PdfMetadata::default();
    assert!(metadata.title.is_none());
    assert!(metadata.author.is_none());
}

#[test]
fn test_document_info() {
    let info = PdfDocumentInfo {
        page_count: 1,
        metadata: PdfMetadata {
            title: Some("Test".to_string()),
            ..Default::default()
        },
        text: "Full text".to_string(),
        pages: vec![PdfPageInfo {
            page_number: 1,
            width: 612.0,
            height: 792.0,
            text: "Page text".to_string(),
        }],
    };
    assert_eq!(info.page_count, 1);
    assert_eq!(info.metadata.title, Some("Test".to_string()));
    assert_eq!(info.pages.len(), 1);
}
