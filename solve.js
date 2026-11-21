// Fast drop-in replacement for csv-reader 1.0.0: for every input {text, header} it returns exactly
// csv-reader's {columns, rows, errors} reading, but as one left-to-right scan that slices each field
// out of the input text instead of building it a character at a time. Dependency-free ES module.
//
// The reading, as csv-reader 1.0.0 defines it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside is one
//     quote, each CRLF or lone CR inside reads as LF); what follows the closing quote up to the next
//     comma or line break is appended as it stands (quote_junk when the field ends); a quote that
//     never closes is a literal character and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with "" (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on
//     (counting every LF, CRLF and lone CR inside quotes), row its record's index in rows (null for
//     the header), a record's short_row or long_row when the record ends.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // How the last field ended: 0 = comma, 1 = line break, 2 = end of text.
  let ended = 2;
  // Characters kept by the last unquoted read (decides quote_junk).
  let added = 0;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters from pos onto `prefix`, up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Sets `ended` and `added`, advances pos and line.
  function readUnquoted(prefix) {
    const start = pos;
    let seg = pos;
    let parts = null;
    let i = pos;
    added = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) { ended = 0; break; }
      if (c === 10) { ended = 1; break; }
      if (c === 13) {
        if (i + 1 < n && text.charCodeAt(i + 1) === 10) { ended = 1; break; }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [prefix, text.slice(seg, i)];
        else parts.push(text.slice(seg, i));
        added += i - seg;
        i += 1;
        seg = i;
        continue;
      }
      i += 1;
    }
    if (i >= n) ended = 2;
    let value;
    if (parts === null) {
      const body = text.slice(start, i);
      added = body.length;
      value = prefix === '' ? body : prefix + body;
    } else {
      parts.push(text.slice(seg, i));
      added += i - seg;
      value = parts.join('');
    }
    if (ended === 0) pos = i + 1;
    else if (ended === 1) { pos = text.charCodeAt(i) === 13 ? i + 2 : i + 1; line += 1; }
    else pos = n;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    let i = pos + 1;
    let seg = i;
    let parts = null;
    let qLines = 0;
    let closed = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        if (i + 1 < n && text.charCodeAt(i + 1) === 34) {
          if (parts === null) parts = [text.slice(seg, i), '"'];
          else { parts.push(text.slice(seg, i)); parts.push('"'); }
          i += 2;
          seg = i;
          continue;
        }
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [text.slice(seg, i), '\n'];
        else { parts.push(text.slice(seg, i)); parts.push('\n'); }
        qLines += 1;
        i += i + 1 < n && text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === 10) qLines += 1;
      i += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    line += qLines;
    let value;
    if (parts === null) value = text.slice(open + 1, i);
    else { parts.push(text.slice(seg, i)); value = parts.join(''); }
    pos = i + 1;
    if (pos >= n) { ended = 2; return value; }
    const c = text.charCodeAt(pos);
    if (c === 44) { ended = 0; pos += 1; return value; }
    if (c === 10) { ended = 1; pos += 1; line += 1; return value; }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { ended = 1; pos += 2; line += 1; return value; }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junked = readUnquoted(value);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junked;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    do {
      lastQuoted = text.charCodeAt(pos) === 34;
      fields.push(lastQuoted ? readQuoted() : readUnquoted(''));
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
