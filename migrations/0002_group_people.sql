CREATE TABLE group_people (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'family' CHECK (role IN ('helper', 'family')),
  needs_english_help INTEGER NOT NULL DEFAULT 0 CHECK (needs_english_help IN (0, 1)),
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, user_id)
);

-- Existing assignments belong to the currently configured family/helper group.
INSERT INTO group_people (chat_id, user_id, role, display_name, updated_at)
SELECT '-1003208961624', user_id, role, display_name, updated_at FROM user_roles;

CREATE INDEX group_english_help ON group_people (chat_id, needs_english_help, user_id);

-- Preserve changes made by the old worker while this migration is deployed.
-- The new worker writes group_people directly; the legacy table is retained.
CREATE TRIGGER legacy_role_insert AFTER INSERT ON user_roles
BEGIN
  INSERT INTO group_people (chat_id, user_id, role, display_name)
  VALUES ('-1003208961624', NEW.user_id, NEW.role, NEW.display_name)
  ON CONFLICT(chat_id, user_id) DO UPDATE SET role = excluded.role,
    display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER legacy_role_update AFTER UPDATE ON user_roles
BEGIN
  INSERT INTO group_people (chat_id, user_id, role, display_name)
  VALUES ('-1003208961624', NEW.user_id, NEW.role, NEW.display_name)
  ON CONFLICT(chat_id, user_id) DO UPDATE SET role = excluded.role,
    display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER legacy_role_delete AFTER DELETE ON user_roles
BEGIN
  UPDATE group_people SET role = 'family', updated_at = CURRENT_TIMESTAMP
  WHERE chat_id = '-1003208961624' AND user_id = OLD.user_id;
END;
