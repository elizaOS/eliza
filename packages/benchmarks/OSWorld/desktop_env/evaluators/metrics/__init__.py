from .basic_os import (
    check_gnome_favorite_apps,
    is_utc_0,
    check_text_enlarged,
    check_moved_jpgs,
    is_in_vm_clickboard
)
from .chrome import (
    is_expected_tabs,
    is_expected_bookmarks,
    compare_pdfs,
    compare_htmls,
    compare_archive,
    is_cookie_deleted,
    is_shortcut_on_desktop,
    check_font_size,
    check_enabled_experiments,
    check_history_deleted,
    is_expected_search_query,
    is_expected_active_tab,
    is_expected_url_pattern_match,
    is_added_to_steam_cart,
    is_expected_installed_extensions,
    compare_pdf_images,
    is_expected_active_tab_approximate
)
from .docs import (
    compare_font_names,
    compare_subscript_contains,
    has_page_numbers_in_footers,
    compare_docx_lines,
    evaluate_colored_words_in_tables,
    check_highlighted_words,
    evaluate_strike_through_last_paragraph,
    evaluate_conversion,
    evaluate_spacing,
    check_italic_font_size_14,
    evaluate_alignment,
    get_unique_train_ids,
    check_no_duplicates,
    compare_init_lines,
    find_default_font,
    contains_page_break,
    compare_docx_files,
    compare_docx_tables,
    compare_line_spacing,
    compare_insert_equation,
    compare_highlighted_text,
    is_first_line_centered,
    check_file_exists,
    check_tabstops,
    compare_contains_image,
    compare_docx_files_and_ignore_new_lines,
    compare_docx_images,
    compare_image_text,
    compare_references,
    compare_unique_train_records
)
from .general import (
    check_csv,
    check_accessibility_tree,
    run_sqlite3,
    check_json,
    check_list,
    exact_match,
    match_in_list,
    is_in_list,
    fuzzy_match,
    check_include_exclude,
    check_direct_json_object,
    compare_time_in_speedtest_results,
    is_included_all_json_objects,
    is_gold_text_included_in_pdf,
    check_line_number,
    file_contains,
    compare_terminal_and_txt,
    fuzzy_place_math,
    compare_python_pure_text,
    diff_text_file,
    literal_match
)
from .gimp import (
    check_structure_sim_resized,
    check_brightness_decrease_and_structure_sim,
    check_contrast_increase_and_structure_sim,
    check_saturation_increase_and_structure_sim,
    check_image_size,
    check_image_mirror,
    check_palette_and_structure_sim,
    check_textbox_on_leftside,
    check_green_background,
    check_file_exists_and_structure_sim,
    check_triangle_position,
    check_structure_sim,
    check_config_status,
    compare_image_list,
    increase_saturation,
    decrease_brightness,
    check_file_exists,
    compare_triangle_positions,
    check_sharper,
    check_image_file_size
)
from .libreoffice import check_libre_locale
from .others import compare_epub, check_mp3_meta
from .pdf import check_pdf_pages
from .slides import (
    check_presenter_console_disable,
    check_image_stretch_and_center,
    check_slide_numbers_color,
    compare_pptx_files,
    check_strikethrough,
    check_slide_orientation_Portrait,
    evaluate_presentation_fill_to_rgb_distance,
    check_left_panel,
    check_transition,
    check_page_number_colors,
    check_auto_saving_time
)
from .table import (
    compare_table,
    compare_csv,
    compare_conference_city_in_order
)
from .thunderbird import (
    check_thunderbird_prefs,
    check_thunderbird_filter,
    check_thunderbird_folder
)
from .vlc import (
    is_vlc_playing,
    is_vlc_recordings_folder,
    is_vlc_fullscreen,
    compare_images,
    compare_audios,
    compare_videos,
    check_qt_bgcone,
    check_one_instance_when_started_from_file,
    check_qt_minimal_view,
    check_qt_max_volume,
    check_qt_slider_colours,
    check_global_key_play_pause
)
from .vscode import (
    compare_text_file,
    compare_config,
    compare_answer,
    compare_result_files,
    is_extension_installed,
    check_json_settings,
    check_json_keybindings,
    check_python_file_by_test_suite,
    check_python_file_by_gold_file,
    check_html_background_image,
    compare_zip_files
)


def infeasible():
    pass
