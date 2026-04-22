# Supabase Security Stance (MindSnap Duels)

This project uses a public Supabase key in frontend code. That is expected.

The security boundary is:
- Row Level Security (RLS) in Supabase
- Backend-only writes for official match history

## Required model

1. Enable RLS on the history table.
2. Do **not** allow direct client `INSERT`, `UPDATE`, or `DELETE` for official rows.
3. Perform writes through backend server code (or an Edge Function using service role key).
4. Keep publishable key in browser only for realtime/lobby use; never put service role key in frontend.

## Recommended table shape

Use a dedicated table for authoritative match history, for example `public.match_history`.

## Example policy baseline

```sql
alter table public.match_history enable row level security;

-- Optional read policy (adjust for your product needs)
create policy "allow read history"
on public.match_history
for select
to anon, authenticated
using (true);

-- Block direct client writes
create policy "deny client insert"
on public.match_history
for insert
to anon, authenticated
with check (false);

create policy "deny client update"
on public.match_history
for update
to anon, authenticated
using (false)
with check (false);

create policy "deny client delete"
on public.match_history
for delete
to anon, authenticated
using (false);
```

## Operational notes

- Validate and normalize payloads in backend before persistence.
- Apply rate limiting on `/api/match/end` to reduce abuse.
- If moving persistence to Supabase, keep backend as the only write path.
- Consider adding signed server metadata (write timestamp, request IP hash, user agent hash) for auditability.
