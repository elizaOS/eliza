#![allow(missing_docs)]

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{Result, RssError};
use crate::types::{RssEnclosure, RssFeed, RssImage, RssItem};

pub fn parse_rss_to_json(xml_content: &str) -> Result<RssFeed> {
    let mut reader = Reader::from_str(xml_content);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut is_atom = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "feed" || name.ends_with(":feed") {
                    is_atom = true;
                }
                break;
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(RssError::XmlParse(e)),
            _ => {}
        }
        buf.clear();
    }

    if is_atom {
        parse_atom_feed(xml_content)
    } else {
        parse_rss_feed(xml_content)
    }
}

fn parse_rss_feed(xml_content: &str) -> Result<RssFeed> {
    let mut reader = Reader::from_str(xml_content);
    reader.config_mut().trim_text(true);

    let mut feed = RssFeed::default();
    let mut buf = Vec::new();
    let mut current_tag = String::new();
    let mut in_channel = false;
    let mut in_item = false;
    let mut in_image = false;
    let mut current_item = RssItem::default();
    let mut current_image = RssImage::default();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                current_tag = name.clone();

                match name.as_str() {
                    "channel" => in_channel = true,
                    "item" => {
                        in_item = true;
                        current_item = RssItem::default();
                    }
                    "image" if in_channel && !in_item => {
                        in_image = true;
                        current_image = RssImage::default();
                    }
                    "enclosure" if in_item => {
                        let mut enclosure = RssEnclosure::default();
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let value = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "url" => enclosure.url = value,
                                "type" => enclosure.media_type = value,
                                "length" => enclosure.length = value,
                                _ => {}
                            }
                        }
                        current_item.enclosure = Some(enclosure);
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match name.as_str() {
                    "channel" => in_channel = false,
                    "item" => {
                        in_item = false;
                        feed.items.push(std::mem::take(&mut current_item));
                    }
                    "image" if in_image => {
                        in_image = false;
                        feed.channel.image = Some(std::mem::take(&mut current_image));
                    }
                    _ => {}
                }
                current_tag.clear();
            }
            Ok(Event::Text(e)) => {
                let text = decode_text(&e.unescape().unwrap_or_default());

                if in_item {
                    match current_tag.as_str() {
                        "title" => current_item.title = text,
                        "link" => current_item.link = text,
                        "description" => current_item.description = text,
                        "pubDate" => current_item.pub_date = text,
                        "author" => current_item.author = text,
                        "category" => current_item.category.push(text),
                        "comments" => current_item.comments = text,
                        "guid" => current_item.guid = text,
                        _ => {}
                    }
                } else if in_image {
                    match current_tag.as_str() {
                        "url" => current_image.url = text,
                        "title" => current_image.title = text,
                        "link" => current_image.link = text,
                        "width" => current_image.width = text,
                        "height" => current_image.height = text,
                        _ => {}
                    }
                } else if in_channel {
                    match current_tag.as_str() {
                        "title" => feed.channel.title = text,
                        "link" => feed.channel.link = text,
                        "description" => feed.channel.description = text,
                        "language" => feed.channel.language = text,
                        "copyright" => feed.channel.copyright = text,
                        "lastBuildDate" => feed.channel.last_build_date = text,
                        "generator" => feed.channel.generator = text,
                        "docs" => feed.channel.docs = text,
                        "ttl" => feed.channel.ttl = text,
                        _ => {}
                    }
                }
            }
            Ok(Event::CData(e)) => {
                let text = String::from_utf8_lossy(&e).to_string();

                if in_item && current_tag == "description" {
                    current_item.description = text;
                } else if in_channel && current_tag == "description" {
                    feed.channel.description = text;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(RssError::XmlParse(e)),
            _ => {}
        }
        buf.clear();
    }

    if feed.channel.title.is_empty() && feed.items.is_empty() {
        return Err(RssError::InvalidFeed(
            "No channel element found".to_string(),
        ));
    }

    Ok(feed)
}

fn parse_atom_feed(xml_content: &str) -> Result<RssFeed> {
    let mut reader = Reader::from_str(xml_content);
    reader.config_mut().trim_text(true);

    let mut feed = RssFeed::default();
    let mut buf = Vec::new();
    let mut current_tag = String::new();
    let mut in_entry = false;
    let mut in_author = false;
    let mut current_item = RssItem::default();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local_name = name.split(':').next_back().unwrap_or(&name);
                current_tag = local_name.to_string();

                match local_name {
                    "entry" => {
                        in_entry = true;
                        current_item = RssItem::default();
                    }
                    "author" => in_author = true,
                    "link" => {
                        let mut href = String::new();
                        let mut rel = String::new();
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let value = String::from_utf8_lossy(&attr.value).to_string();
                            match key.as_str() {
                                "href" => href = value,
                                "rel" => rel = value,
                                _ => {}
                            }
                        }
                        if rel.is_empty() || rel == "alternate" {
                            if in_entry {
                                current_item.link = href;
                            } else {
                                feed.channel.link = href;
                            }
                        }
                    }
                    "category" => {
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            if key == "term" {
                                let value = String::from_utf8_lossy(&attr.value).to_string();
                                if in_entry {
                                    current_item.category.push(value);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local_name = name.split(':').next_back().unwrap_or(&name);

                match local_name {
                    "entry" => {
                        in_entry = false;
                        feed.items.push(std::mem::take(&mut current_item));
                    }
                    "author" => in_author = false,
                    _ => {}
                }
                current_tag.clear();
            }
            Ok(Event::Text(e)) => {
                let text = decode_text(&e.unescape().unwrap_or_default());

                if in_entry {
                    match current_tag.as_str() {
                        "title" => current_item.title = text,
                        "summary" | "content" if current_item.description.is_empty() => {
                            current_item.description = text;
                        }
                        "published" | "updated" if current_item.pub_date.is_empty() => {
                            current_item.pub_date = text;
                        }
                        "id" => current_item.guid = text,
                        "name" if in_author => current_item.author = text,
                        _ => {}
                    }
                } else {
                    match current_tag.as_str() {
                        "title" => feed.channel.title = text,
                        "subtitle" => feed.channel.description = text,
                        "updated" => feed.channel.last_build_date = text,
                        "generator" => feed.channel.generator = text,
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(RssError::XmlParse(e)),
            _ => {}
        }
        buf.clear();
    }

    Ok(feed)
}

fn decode_text(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .trim()
        .to_string()
}

pub fn create_empty_feed() -> RssFeed {
    RssFeed::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_basic_rss() {
        let xml = r#"<?xml version="1.0"?>
            <rss version="2.0">
                <channel>
                    <title>Test Feed</title>
                    <link>https://example.com</link>
                    <description>A test RSS feed</description>
                    <item>
                        <title>Test Article</title>
                        <link>https://example.com/article1</link>
                        <guid>article-1</guid>
                    </item>
                </channel>
            </rss>"#;

        let feed = parse_rss_to_json(xml).unwrap();
        assert_eq!(feed.title(), "Test Feed");
        assert_eq!(feed.items.len(), 1);
        assert_eq!(feed.items[0].title, "Test Article");
    }

    #[test]
    fn test_parse_rss_with_categories() {
        let xml = r#"<?xml version="1.0"?>
            <rss version="2.0">
                <channel>
                    <title>Test Feed</title>
                    <item>
                        <title>Multi-category Article</title>
                        <category>Tech</category>
                        <category>News</category>
                    </item>
                </channel>
            </rss>"#;

        let feed = parse_rss_to_json(xml).unwrap();
        assert_eq!(feed.items[0].category.len(), 2);
        assert!(feed.items[0].category.contains(&"Tech".to_string()));
        assert!(feed.items[0].category.contains(&"News".to_string()));
    }

    #[test]
    fn test_create_empty_feed() {
        let feed = create_empty_feed();
        assert!(feed.channel.title.is_empty());
        assert!(feed.items.is_empty());
    }
}
